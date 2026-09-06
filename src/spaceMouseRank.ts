/**
 * SpaceMouse-class device discovery ranking (roadmap Tier 2 item 2,
 * Phase-0 probe — hardware-free, unit-tested).
 *
 * Pure and vscode/DOM/HID-free: ranks one enumerated HID interface as a
 * 6DOF-controller candidate from its vendor id + usage page/usage alone, so
 * it unit-tests headless with no device present. Ported from SindriCAD's
 * `spacemouse.rs` `rank()` (including its test vectors and the comments
 * explaining each branch — the Logitech-collision history is the reason
 * this function exists in this shape).
 *
 * The HID usage that DEFINES a 6DOF controller is Generic Desktop (0x01) /
 * Multi-axis Controller (0x08) — the spec's own signal, so it identifies
 * ANY 3D mouse, including models no allowlist ever listed. Matching on
 * vendor id alone was a real, shipped bug (0x046d is Logitech's, shared
 * with every mouse/keyboard/Unifying receiver they make): on a machine
 * with a Logitech mouse it opened the mouse and fed its reports through
 * as 6DOF motion. Hence ranking, not filtering — and hence the decoy rule
 * below, which rejects a collection that positively identifies as
 * mouse/keyboard even under a matching vendor id.
 */

export const SPACEMOUSE_VENDORS = [0x256f, 0x046d] as const;

/** 3Dconnexion (current) + Logitech (older Logitech-branded devices). */
export function isKnownSpaceMouseVendor(vendorId: number): boolean {
  return (SPACEMOUSE_VENDORS as readonly number[]).includes(vendorId);
}

export const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
export const USAGE_MULTI_AXIS = 0x08;
export const USAGE_MOUSE = 0x02;
export const USAGE_KEYBOARD = 0x06;

/**
 * Scores at or below this were matched on vendor id alone and have NOT
 * proven they are 6DOF controllers. Phase 1 must confirm such a device
 * against its own report descriptor (see `hidDescriptor.ts`) before
 * streaming — with one deliberate exception carried over from SindriCAD:
 * where the descriptor is unavailable, stream anyway with a loud note
 * rather than regress a device that works today (`node-hid` exposes no
 * report-descriptor API, so on platforms that don't populate usage info
 * this is the only honest option).
 */
export const UNPROVEN = 1;

/**
 * Rank one HID interface as a 6DOF-controller candidate; `null` = never
 * open it. Higher is better. The caller opens the BEST-ranked interface
 * only — never falls through to a lower rank when the best won't open
 * (on Linux "listed but won't open" means the udev rule is missing, and
 * quietly opening some other Logitech device instead is precisely the
 * bug being fixed here).
 */
export function rankSpaceMouseCandidate(
  vendorId: number,
  usagePage: number,
  usage: number
): number | null {
  const multiAxis = usagePage === USAGE_PAGE_GENERIC_DESKTOP && usage === USAGE_MULTI_AXIS;
  const vendor = isKnownSpaceMouseVendor(vendorId);
  // A usage that positively says "mouse"/"keyboard" is a definitive NO
  // even under a matching vendor id — that is exactly the Logitech
  // collision (a Unifying receiver's mouse/keyboard collections).
  const decoy =
    usagePage === USAGE_PAGE_GENERIC_DESKTOP && (usage === USAGE_MOUSE || usage === USAGE_KEYBOARD);
  if (decoy) {
    return null;
  }
  // Usage page 0 means the platform didn't populate usage info, so
  // enumeration alone cannot tell — keep the vendor fallback as UNPROVEN.
  const usageKnown = usagePage !== 0;
  if (multiAxis && vendor) return 3; // a 3D mouse from a vendor we know
  if (multiAxis && !vendor) return 2; // a 3D mouse from a vendor we don't
  if (!multiAxis && vendor && !usageKnown) return UNPROVEN; // vendor match, usage unknown — UNPROVEN
  return null;
}
