//! A native file drag out of the window, the way Finder drags a file (macOS), for the B-roll Library
//! (spyglass.rs). Adapted from CrabNebula's drag-rs (drag 2.1.1, `platform_impl/macos`, MIT/Apache-2.0,
//! Copyright 2023 CrabNebula Ltd.), with one difference that matters to Premiere Pro:
//!
//! drag-rs offers a single drag operation (Copy or Move). Finder offers Copy, Link and Generic, and an
//! editor that links to media rather than copying it answers with Link or Generic. AppKit intersects the
//! two, so with Copy alone Premiere's timeline got no operation it would take: no insert indicator and no
//! drop (live, 2026-10-06). This source offers what Finder offers (minus Move, which would invite the
//! target to delete the original).
//!
//! The file goes on the pasteboard through `NSURL`'s own pasteboard writer, as Finder's does, so the
//! editor reads it as `public.file-url`, or as the legacy `NSFilenamesPboardType` that AppKit derives.

use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent, NSEventModifierFlags,
    NSEventType, NSImage, NSView,
};
use objc2_foundation::{NSData, NSMutableArray, NSPoint, NSRect, NSString, NSURL};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::path::Path;

/// What the drag offers the drop target: Finder's file drag, without Move.
pub fn offered_operations() -> NSDragOperation {
    NSDragOperation::Copy | NSDragOperation::Link | NSDragOperation::Generic
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VibeCutAgentFileDragSource"]
    struct FileDragSource;

    unsafe impl NSObjectProtocol for FileDragSource {}

    unsafe impl NSDraggingSource for FileDragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        unsafe fn source_operation_mask(&self, session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
            session.setAnimatesToStartingPositionsOnCancelOrFail(true);
            offered_operations()
        }
    }
);

impl FileDragSource {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// Starts dragging `file` from `window`, with `icon` (PNG bytes) under the cursor. Call on the main
/// thread while the mouse button is down.
pub fn start_file_drag<W: HasWindowHandle>(window: &W, file: &Path, icon: &[u8]) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("A drag must start on the main thread")?;
    let Ok(RawWindowHandle::AppKit(handle)) = window.window_handle().map(|h| h.as_raw()) else {
        return Err("This window can't start a drag".into());
    };
    // SAFETY: the handle's NSView belongs to this window, which is alive for the whole call.
    let ns_view = unsafe { &*(handle.ns_view.as_ptr() as *const NSView) };
    let ns_window = ns_view.window().ok_or("The window isn't on screen")?;
    let content = ns_window.contentView().ok_or("The window has no content")?;

    let image = NSImage::initWithData(NSImage::alloc(), &NSData::from_vec(icon.to_vec())).ok_or("The drag icon couldn't be read")?;
    let size = image.size();
    let at = ns_window.mouseLocationOutsideOfEventStream();
    let frame = NSRect::new(NSPoint::new(at.x - size.width / 2.0, at.y - size.height / 2.0), size);

    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&file.to_string_lossy()), false);
    let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &ProtocolObject::from_retained(url));
    // SAFETY: `image` is a valid NSImage kept alive by the item.
    unsafe { item.setDraggingFrame_contents(frame, Some(&image)) };
    let items = NSMutableArray::<NSDraggingItem>::new();
    items.addObject(&*item);

    let timestamp = NSApp(mtm).currentEvent().map(|e| e.timestamp()).unwrap_or(0.0);
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged,
        at,
        NSEventModifierFlags::empty(),
        timestamp,
        ns_window.windowNumber(),
        None,
        0,
        1,
        1.0,
    )
    .ok_or("The drag couldn't start")?;
    let source = FileDragSource::new(mtm);
    let _session = content.beginDraggingSessionWithItems_event_source(&items, &event, &ProtocolObject::from_retained(source));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_offers_what_finder_offers_but_move() {
        let offered = offered_operations();
        for wanted in [NSDragOperation::Copy, NSDragOperation::Link, NSDragOperation::Generic] {
            assert!(offered.contains(wanted));
        }
        assert!(!offered.contains(NSDragOperation::Move));
        assert!(!offered.contains(NSDragOperation::Delete));
    }
}
