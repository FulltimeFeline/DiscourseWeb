// A single shared IntersectionObserver for timeline rows.
//
// Each MessageRow needs a one-shot "became visible" signal (to lazily fetch its
// encryption shield). Creating one IntersectionObserver per row means fast
// scrolling churns observers as Virtuoso mounts/unmounts rows. Instead, share a
// single observer against the viewport and dispatch to a per-element callback.

type Callback = () => void;

const callbacks = new WeakMap<Element, Callback>();
let observer: IntersectionObserver | undefined;

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const cb = callbacks.get(e.target);
          if (!cb) continue;
          callbacks.delete(e.target);
          observer!.unobserve(e.target);
          cb();
        }
      },
      { threshold: 0.1 },
    );
  }
  return observer;
}

/**
 * Fire `cb` the first time `el` becomes visible, then stop observing it. Returns
 * an unobserve function to call on unmount (safe if `cb` already fired).
 */
export function observeOnce(el: Element, cb: Callback): () => void {
  const obs = getObserver();
  callbacks.set(el, cb);
  obs.observe(el);
  return () => {
    callbacks.delete(el);
    obs.unobserve(el);
  };
}
