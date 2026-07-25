// Element Call embedding.
//
// Element Call runs in an <iframe>, and the widget postMessage bridge is a direct
// window.addEventListener('message') + iframe.contentWindow.postMessage pair.
// WebRTC lives entirely inside the iframe (media granted via the iframe `allow`
// attribute).
//
// Wiring through the SDK widget driver:
//   newVirtualElementCallWidget -> generateWebviewUrl -> makeWidgetDriver
//   -> driver.run(room, capabilitiesProvider); pump handle.recv() into the
//   iframe; forward inbound messages via handle.send().
//
// The iframe registration is late-bound: the view sets `iframe` once mounted,
// then calls start(); the driver pump waits for it.

import { ViewModel } from "@/core/reactive";
import type { MatrixSession } from "@/core/MatrixSession";
import {
  ClientProperties,
  EncryptionSystem,
  generateWebviewUrl,
  getElementCallRequiredPermissions,
  Intent,
  makeWidgetDriver,
  newVirtualElementCallWidget,
  VirtualElementCallWidgetConfig,
  VirtualElementCallWidgetProperties,
  type RoomInterface,
  type WidgetCapabilities,
  type WidgetDriverHandleInterface,
  type WidgetDriverInterface,
} from "@/matrix";

/** Default Element Call SPA (configurable / overridable per deployment). */
export const DEFAULT_EC_BASE_URL = "https://call.element.io";

/** Our client id, passed via `ClientProperties(clientId:)`. */
const CLIENT_ID = "com.riiiiiiiley.discourse";

// Host-handled actions: acked locally and NOT forwarded to the driver, else the
// driver returns an "unknown variant" error that desyncs EC's state machine
// (mic shows muted while unmuted, join stalls).
const HOST_HANDLED_ACTIONS = new Set([
  "io.element.join",
  "io.element.device_mute",
  "set_always_on_screen",
  "io.element.tile_layout",
]);

// Actions that mean "the call is over": close the view.
const HANGUP_ACTIONS = new Set(["close", "im.vector.hangup", "io.element.close"]);

interface State {
  status: "idle" | "loading" | "running" | "ended" | "error";
  url?: string;
  ecOrigin?: string;
  error?: string;
}

// --- .well-known Element Call discovery --------------------------------------

interface CacheEntry {
  url: string; // resolved widget base ("…/room")
  at: number;
}
const wellKnownCache = new Map<string, CacheEntry>();

/**
 * Discover the Element Call widget base URL from the user's homeserver
 * `.well-known/matrix/client` (`io.element.call.widget_url`). Appends `/room`
 * for a bare origin. Falls back to `${fallback}/room`. 200/404 are cached;
 * 5xx/429/network are transient and not cached.
 */
export async function discoverElementCallUrl(
  userId: string,
  fallback: string = DEFAULT_EC_BASE_URL,
): Promise<string> {
  const fallbackRoom = ensureRoomPath(fallback);
  const i = userId.indexOf(":");
  const server = i === -1 ? "" : userId.slice(i + 1);
  if (!server) return fallbackRoom;

  const cached = wellKnownCache.get(server);
  if (cached) return cached.url;

  try {
    const res = await fetch(`https://${server}/.well-known/matrix/client`);
    if (res.status === 404) {
      wellKnownCache.set(server, { url: fallbackRoom, at: Date.now() });
      return fallbackRoom;
    }
    if (!res.ok) return fallbackRoom; // 5xx/429: transient, don't cache
    const json = await res.json();
    const raw = json["io.element.call"]?.widget_url ?? json["io.element.call.widget_url"];
    const resolved = typeof raw === "string" && raw ? ensureRoomPath(raw) : fallbackRoom;
    wellKnownCache.set(server, { url: resolved, at: Date.now() });
    return resolved;
  } catch {
    return fallbackRoom; // network error: transient
  }
}

/** Append `/room` when the URL has an empty or "/" path (bare origin). */
function ensureRoomPath(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname === "" || u.pathname === "/") {
      u.pathname = "/room";
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

// --- capabilities provider ---------------------------------------------------

/** Grants Element Call exactly the capabilities it needs. */
function makeCapabilitiesProvider(ownUserId: string, ownDeviceId: string) {
  return {
    acquireCapabilities(_capabilities: WidgetCapabilities): WidgetCapabilities {
      return getElementCallRequiredPermissions(ownUserId, ownDeviceId);
    },
  };
}

// --- view model --------------------------------------------------------------

export class CallViewModel extends ViewModel<State> {
  private iframe?: HTMLIFrameElement;
  /** Driver→widget messages produced before the iframe existed. postMessage to a
   *  not-yet-attached iframe is lost, and the widget-API handshake frames
   *  (supported_api_versions, capabilities) are emitted immediately — dropping
   *  them left Element Call waiting forever ("Request timed out"). Queue + flush. */
  private pendingOutbound: unknown[] = [];
  private driver?: WidgetDriverInterface;
  private handle?: WidgetDriverHandleInterface;
  private pumpAbort?: AbortController;
  private messageListener?: (e: MessageEvent) => void;
  private stopped = false;
  // Screen wake lock held for the call's duration so a hidden/occluded tab
  // doesn't throttle the MatrixRTC "delayed leave" heartbeat and drop the user.
  private wakeLock?: { release(): Promise<void> };
  private readonly onVisibility = () => {
    if (document.visibilityState === "visible" && !this.stopped) void this.acquireWakeLock();
  };

  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLock) return;
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this.wakeLock = await wl?.request("screen");
    } catch {
      /* denied or unsupported (non-secure context, no permission) */
    }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = undefined;
  }

  constructor(
    private readonly session: MatrixSession,
    private readonly room: RoomInterface,
    private readonly ownUserId: string,
    /** true when joining an in-progress call (RoomInfo.hasRoomCall). */
    private readonly joinExisting: boolean,
    private readonly baseUrl: string = DEFAULT_EC_BASE_URL,
    /** Called when EC signals hangup/close (the view then dismisses). */
    private readonly onHangup?: () => void,
    /** When true the room couldn't be resolved; start() errors immediately. */
    private readonly missingRoom: boolean = false,
  ) {
    super({ status: "idle" });
  }

  /** The <iframe> registers itself once mounted. */
  attachIframe(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
    // Flush any handshake frames the driver emitted before the iframe existed.
    if (this.pendingOutbound.length && this.state.ecOrigin) {
      const queued = this.pendingOutbound;
      this.pendingOutbound = [];
      for (const m of queued) this.postToWidget(m);
    }
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.missingRoom) {
      this.setState({ status: "error", error: "Room not found." });
      return;
    }
    this.setState({ status: "loading" });
    activeCallRooms.add(this.room.id());
    void this.acquireWakeLock();
    document.addEventListener("visibilitychange", this.onVisibility);

    try {
      const ecBase = await discoverElementCallUrl(this.ownUserId, this.baseUrl);
      const ecOrigin = new URL(ecBase).origin;

      const widgetId = cryptoRandomId();
      const props = VirtualElementCallWidgetProperties.create({
        elementCallUrl: ecBase,
        widgetId,
        // `parentUrl` is the HOST origin that matrix-widget-api uses as the
        // targetOrigin when the widget posts its fromWidget messages to
        // window.parent (us). It MUST be our app's origin — if it's ecBase
        // (call.element.io), the browser drops every EC→host message because
        // our real origin doesn't match, so the widget-API handshake
        // (supported_api_versions, capabilities) times out and the call hangs
        // on "loading" forever. It's also what EC validates our host→widget
        // messages' sender origin against.
        parentUrl: typeof window !== "undefined" ? window.location.origin : ecBase,
        fontScale: undefined,
        font: undefined,
        encryption: EncryptionSystem.PerParticipantKeys.new(),
        posthogUserId: undefined,
        posthogApiHost: undefined,
        posthogApiKey: undefined,
        rageshakeSubmitUrl: undefined,
        sentryDsn: undefined,
        sentryEnvironment: undefined,
      });

      const config = VirtualElementCallWidgetConfig.create({
        intent: this.joinExisting ? Intent.JoinExisting : Intent.StartCall,
        skipLobby: false,
        header: undefined,
        hideHeader: true,
        preload: undefined,
        appPrompt: false,
        confineToRoom: true,
        hideScreensharing: false,
        controlledAudioDevices: undefined,
        sendNotificationType: undefined,
      });

      const settings = newVirtualElementCallWidget(props, config);
      const clientProps = ClientProperties.create({
        clientId: CLIENT_ID,
        languageTag: undefined,
        theme: undefined,
      });
      const url = await generateWebviewUrl(settings, this.room, clientProps);

      // Build + run the driver.
      const { driver, handle } = makeWidgetDriver(settings);
      this.driver = driver;
      this.handle = handle;

      let deviceId = this.session.session()?.deviceId ?? "";
      if (!deviceId) {
        try {
          deviceId = this.session.client.deviceId();
        } catch {
          /* leave empty */
        }
      }
      const capabilities = makeCapabilitiesProvider(this.ownUserId, deviceId);

      this.pumpAbort = new AbortController();
      // driver.run resolves when the call ends; don't await it here.
      void driver
        .run(this.room, capabilities, { signal: this.pumpAbort.signal })
        .catch(() => {});

      this.installMessageBridge(ecOrigin);
      void this.pumpDriverToWidget();

      this.setState({ status: "running", url, ecOrigin });
    } catch (e) {
      this.setState({
        status: "error",
        error: e instanceof Error ? e.message : "Couldn't start the call.",
      });
      activeCallRooms.delete(this.room.id());
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = undefined;
    }
    this.pumpAbort?.abort();
    this.pumpAbort = undefined;
    this.driver = undefined;
    this.handle = undefined;
    this.iframe = undefined;
    activeCallRooms.delete(this.room.id());
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.releaseWakeLock();
    if (this.state.status !== "error") this.setState({ status: "ended" });
  }

  override dispose(): void {
    this.stop();
    super.dispose();
  }

  // --- widget → driver (inbound) --------------------------------------------

  private installMessageBridge(ecOrigin: string): void {
    const listener = (event: MessageEvent) => {
      // Only accept messages from the Element Call origin.
      if (event.origin !== ecOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;

      // Only bridge the two relevant frame shapes:
      //   widget->driver request:  !response && api == 'fromWidget'
      //   driver->widget response: response && api == 'toWidget'
      const isFromWidget = !data.response && data.api === "fromWidget";
      const isToWidgetResponse = data.response && data.api === "toWidget";
      if (!isFromWidget && !isToWidgetResponse) return;

      const action: string = typeof data.action === "string" ? data.action : "";

      // Hangup/close: tear down our chrome, but STILL forward the message so the
      // widget driver emits the RTC membership leave. Fire the callback, do NOT
      // early-return, otherwise remote users see this user stuck "in call".
      if (action.includes("hangup") || HANGUP_ACTIONS.has(action)) {
        this.onHangup?.();
        // fall through to forward to the driver
      } else if (isFromWidget && HOST_HANDLED_ACTIONS.has(action)) {
        // Host-handled actions: ack locally, do NOT forward to the driver.
        this.ackLocally(data);
        return;
      }

      // Everything else (incl. hangup) goes to the driver.
      const msg = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      void this.handle?.send(msg).catch(() => {});
    };
    this.messageListener = listener;
    window.addEventListener("message", listener);
  }

  /** Echo the request back with a `response` key matched by requestId. */
  private ackLocally(request: any): void {
    const responseData = request.action === "set_always_on_screen" ? { success: true } : {};
    const reply = { ...request, response: responseData };
    this.postToWidget(reply);
  }

  // --- driver → widget (outbound) -------------------------------------------

  private async pumpDriverToWidget(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    while (!this.stopped) {
      let message: string | undefined;
      try {
        message = await handle.recv();
      } catch {
        break;
      }
      if (message === undefined) break; // driver no longer running
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        parsed = message;
      }
      this.postToWidget(parsed);
    }
  }

  private postToWidget(message: unknown): void {
    const win = this.iframe?.contentWindow;
    const origin = this.state.ecOrigin;
    if (!win || !origin) {
      // Iframe not attached yet — queue so early handshake frames aren't lost;
      // attachIframe() flushes them. Bounded so a stuck attach can't grow it.
      if (this.pendingOutbound.length < 256) this.pendingOutbound.push(message);
      return;
    }
    try {
      win.postMessage(message, origin);
    } catch {
      /* iframe navigated away */
    }
  }
}

// --- active-call registry ----------------------------------------------------
//
// Rooms whose call we started/opened locally. The ring watcher skips these so we
// don't ring ourselves.

export const activeCallRooms = new Set<string>();

export function isLocallyActiveCall(roomId: string): boolean {
  return activeCallRooms.has(roomId);
}

// --- helpers -----------------------------------------------------------------

function cryptoRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `w${Date.now()}${Math.random().toString(36).slice(2)}`;
  }
}
