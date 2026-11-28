import { $ } from "./core.js";

function linkAbort(parentSignal, extraSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted || extraSignal?.aborted) {
    controller.abort();
    return { controller, detach() {} };
  }
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  extraSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    detach() {
      parentSignal?.removeEventListener("abort", onAbort);
      extraSignal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Coordinates reader async lifecycles and readiness invariants with AbortControllers. */
export class ReaderInteraction {
  constructor(reader) {
    this.r = reader;
    this.phase = "idle";
    this._lookupController = null;
    this._lookupDetach = null;
    this._refreshController = null;
    this._refreshDetach = null;
    this._reflowController = null;
    this._reflowDetach = null;
    reader.scope.signal.addEventListener("abort", () => this.dispose(), { once: true });
  }

  /** Begin a word-lookup request, aborting any previous in-flight lookup. */
  beginLookup() {
    this.cancelLookup();
    const { controller, detach } = linkAbort(this.r.scope.signal);
    this._lookupController = controller;
    this._lookupDetach = detach;
    this.syncPhase();
    return {
      signal: controller.signal,
      finish: () => {
        if (this._lookupController !== controller) return;
        this._lookupDetach?.();
        this._lookupDetach = null;
        this._lookupController = null;
        this.syncPhase();
      },
    };
  }

  /** Abort any in-flight word lookup. */
  cancelLookup() {
    this._lookupDetach?.();
    this._lookupDetach = null;
    this._lookupController?.abort();
    this._lookupController = null;
    this.syncPhase();
  }

  /** Begin a document refresh, aborting any earlier superseded refresh. */
  beginRefresh() {
    this._refreshDetach?.();
    this._refreshDetach = null;
    this._refreshController?.abort();
    const { controller, detach } = linkAbort(this.r.scope.signal);
    this._refreshController = controller;
    this._refreshDetach = detach;
    this.r.restoring = true;
    this.syncPhase();
    return {
      signal: controller.signal,
      detach: () => {
        if (this._refreshController === controller) {
          this._refreshDetach?.();
          this._refreshDetach = null;
        } else {
          detach();
        }
      },
      complete: () => {
        if (this._refreshController === controller) {
          this._refreshController = null;
        }
        this.r.restoring = false;
        this.syncPhase();
      },
    };
  }

  /** Begin an annotation-reflow async run, cancelling any prior run. */
  beginReflow(parentSignal = null) {
    this.cancelReflow();
    const { controller, detach } = linkAbort(this.r.scope.signal, parentSignal);
    this._reflowController = controller;
    this._reflowDetach = detach;
    this.syncPhase();
    return {
      signal: controller.signal,
      finish: () => {
        if (this._reflowController !== controller) return;
        this._reflowDetach?.();
        this._reflowDetach = null;
        this._reflowController = null;
        this.syncPhase();
      },
    };
  }

  /** Abort the active annotation-reflow async run, if any. */
  cancelReflow() {
    this._reflowDetach?.();
    this._reflowDetach = null;
    this._reflowController?.abort();
    this._reflowController = null;
    this.syncPhase();
  }

  /** Recompute the visible reader phase from live state. */
  syncPhase() {
    const r = this.r, pages = r.pages, word = pages?.wordReflow;
    if (r.scope.signal.aborted) {
      this.phase = "disposed";
    } else if ((this._refreshController && !this._refreshController.signal.aborted) || r.restoring) {
      this.phase = "refreshing";
    } else if (pages?.animating || pages?.preview) {
      this.phase = "turning";
    } else if (word?.updating || word?.flushing || (word?.owner?.isConnected && ["preparing", "playing"].includes(word.owner.dataset.reflowPhase))) {
      this.phase = "reflowing";
    } else if (this._lookupController && !this._lookupController.signal.aborted) {
      this.phase = "lookup";
    } else if (this.isSettled()) {
      this.phase = "settled";
    } else {
      this.phase = "idle";
    }
    return this.phase;
  }

  /** Return true when pagination, refresh, and annotation work are quiescent. */
  isSettled() {
    const r = this.r, pages = r.pages, word = pages?.wordReflow;
    return Boolean(
      !r.scope.signal.aborted &&
      pages?.complete &&
      pages.layoutComplete &&
      Number.isInteger(pages.layoutEpoch) &&
      !r.restoring &&
      !pages.displayPending &&
      !pages.animating &&
      !pages.retainedLayoutPending &&
      !r.annotationRefreshPending &&
      !word?.pendingLayout &&
      !word?.flushing &&
      !word?.updating &&
      !word?.pendingCanonical &&
      !(word?.owner?.isConnected && ["preparing", "playing"].includes(word.owner.dataset.reflowPhase))
    );
  }

  /** Return true when progress sampling may record the current spread anchor. */
  canRecordPosition() {
    return !document.hidden && !this.r.popElement && !this.r.pages?.canonicalDirty && this.isSettled();
  }

  /** Return true when page turning/grabbing input is allowed. */
  canGrab({ ownPreview = false, allowOpenCard = false } = {}) {
    const r = this.r, pages = r.pages;
    return Boolean(
      !r.scope.signal.aborted &&
      (allowOpenCard || !r.popElement) &&
      !r.focus?.isOpen() &&
      !r.aiSetupOpen &&
      !r.grammarInspecting &&
      !r.panelId &&
      !document.querySelector("dialog[open]") &&
      !$("#reading-stage")?.inert &&
      !$("#translation-pane")?.hasAttribute("data-selection-open") &&
      !pages?.displayPending &&
      (!pages?.animating || ownPreview)
    );
  }

  /** Abort all tracked interaction controllers when the reader closes. */
  dispose() {
    this.cancelLookup();
    this._refreshDetach?.();
    this._refreshDetach = null;
    this._refreshController?.abort();
    this._refreshController = null;
    this.cancelReflow();
    this.phase = "disposed";
  }
}
