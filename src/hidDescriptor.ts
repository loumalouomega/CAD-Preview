/**
 * HID report-descriptor walk answering one question — does this device
 * declare itself a 6DOF controller? (roadmap Tier 2 item 2, Phase-0 probe
 * — hardware-free, unit-tested).
 *
 * Pure and dependency-free: walks the HID short-item encoding (prefix byte
 * carrying tag/type/size, then 0/1/2/4 data bytes), tracking the current
 * Usage Page (global item) and looking for a Usage of Multi-axis
 * Controller under Generic Desktop. Ported from SindriCAD's
 * `declares_multi_axis` with its fixtures — including the adversarial ones
 * (truncation proves nothing, 4-byte items must not desync the walk,
 * usage 0x08 on another page is button 8, not multi-axis).
 *
 * Why this exists: where enumeration populates no usage info
 * (`usagePage === 0`), `spaceMouseRank.ts` can only score a vendor match
 * as UNPROVEN. The device's own descriptor is the only evidence that
 * settles the Logitech vendor-id collision in that case. `node-hid`
 * exposes NO report-descriptor API (verified against its installed
 * `nodehid.d.ts` — devices, open, read, write, feature reports only), so
 * on such platforms Phase 1 falls back to stream-with-a-loud-note rather
 * than a silent trust. This module is still load-bearing: it is the
 * check to run wherever a descriptor IS obtainable, and it unit-tests
 * the walk logic Phase 1 would otherwise ship untested.
 */
export function declaresMultiAxis(desc: readonly number[] | Uint8Array): boolean {
  const ITEM_USAGE_PAGE = 0x04;
  const ITEM_USAGE = 0x08;
  const LONG_ITEM = 0xfe;

  let page = 0;
  let i = 0;
  while (i < desc.length) {
    const prefix = desc[i];
    if (prefix === LONG_ITEM) {
      // [0xfe, dataSize, tag, data...] — nothing we need, step over it.
      const size = desc[i + 1];
      if (size === undefined) return false;
      i += 3 + size;
      continue;
    }
    // A size field of 3 means FOUR bytes, not three.
    const size = (prefix & 0x03) === 3 ? 4 : prefix & 0x03;
    if (i + 1 + size > desc.length) {
      return false; // truncated descriptor — do not guess
    }
    let value = 0;
    for (let k = 0; k < size; k++) {
      value |= desc[i + 1 + k] << (8 * k); // HID data is little-endian
    }
    switch (prefix & 0xfc) {
      case ITEM_USAGE_PAGE:
        page = value & 0xffff;
        break;
      case ITEM_USAGE: {
        // A 4-byte usage is "extended": it carries its own page in the
        // high half and ignores the current one.
        const p = size === 4 ? (value >>> 16) & 0xffff : page;
        const u = value & 0xffff;
        if (p === 0x01 && u === 0x08) {
          return true;
        }
        break;
      }
      default:
        break;
    }
    i += 1 + size;
  }
  return false;
}
