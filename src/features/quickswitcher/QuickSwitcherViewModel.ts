// ⌘K quick switcher view model. Pure client-side fuzzy filter over the in-memory
// room list (RoomIndex), with no SDK call per keystroke. Rooms keep syncing
// while open: the VM re-filters whenever the underlying `rooms` store changes.

import { ViewModel } from "@/core/reactive";
import type { AppState } from "@/app/AppState";
import { queryRooms, type RoomEntry, type RoomIndex } from "./RoomIndex";

interface State {
  query: string;
  results: RoomEntry[];
  activeIndex: number;
}

const MAX_RESULTS = 50;

export class QuickSwitcherViewModel extends ViewModel<State> {
  constructor(
    private readonly app: AppState,
    private readonly index: RoomIndex,
  ) {
    super({ query: "", results: [], activeIndex: 0 });
    // Re-filter on live room-list changes while the palette is open.
    this.onDispose(this.index.rooms.subscribe(() => this.recompute()));
    this.recompute();
  }

  setQuery(query: string): void {
    this.setState({ query });
    this.recompute();
  }

  private recompute(): void {
    const results = queryRooms(this.index.rooms.value, this.state.query).slice(0, MAX_RESULTS);
    const activeIndex = Math.min(this.state.activeIndex, Math.max(0, results.length - 1));
    this.setState({ results, activeIndex });
  }

  moveBy(delta: number): void {
    const n = this.state.results.length;
    if (n === 0) return;
    const next = (this.state.activeIndex + delta + n) % n;
    this.setState({ activeIndex: next });
  }

  setActive(index: number): void {
    this.setState({ activeIndex: index });
  }

  /** Open the highlighted room and close the palette. */
  confirm(index = this.state.activeIndex): void {
    const room = this.state.results[index];
    if (!room) return;
    this.app.selectRoom(room.id); // also closes the switcher (AppState)
  }

  close(): void {
    this.app.setQuickSwitcherOpen(false);
  }
}
