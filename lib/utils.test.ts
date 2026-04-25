import { describe, it, expect } from "vitest";
import {
  alertTone,
  detectLocationInText,
  expandLocationTags,
  formatTimestamp,
  nearestLocationTo,
  teamName,
} from "./utils";
import type { Location } from "./supabase";

describe("alertTone", () => {
  it("returns 'panic' for messages starting with PANIC", () => {
    expect(alertTone("PANIC — emergency help needed")).toBe("panic");
    expect(alertTone("panic in the kitchen")).toBe("panic");
    expect(alertTone("PANIC")).toBe("panic");
  });

  it("returns 'standdown' for messages starting with STAND DOWN", () => {
    expect(alertTone("STAND DOWN — false alarm")).toBe("standdown");
    expect(alertTone("stand down everyone")).toBe("standdown");
  });

  it("returns 'beep' for everything else", () => {
    expect(alertTone("hello world")).toBe("beep");
    expect(alertTone("a panic happened in the kids wing")).toBe("beep"); // not at start
    expect(alertTone("astand down")).toBe("beep"); // word boundary required
    expect(alertTone("")).toBe("beep");
  });
});

describe("detectLocationInText", () => {
  it("returns the matching location slug", () => {
    expect(detectLocationInText("intruder at @Kids Sanctuary")).toBe(
      "kids_sanctuary"
    );
    expect(detectLocationInText("meet at @Main Sanctuary")).toBe(
      "main_sanctuary"
    );
    expect(detectLocationInText("@KD Ellis Hall fire")).toBe("kd_ellis_hall");
  });

  it("is case-insensitive", () => {
    expect(detectLocationInText("@kids sanctuary now")).toBe("kids_sanctuary");
    expect(detectLocationInText("@MAIN SANCTUARY")).toBe("main_sanctuary");
    expect(detectLocationInText("Help @Parking Lot Front")).toBe(
      "parking_lot_front"
    );
  });

  it("returns null when no @-tag matches a known location", () => {
    expect(detectLocationInText("just a message")).toBe(null);
    expect(detectLocationInText("@somewhere else")).toBe(null);
    expect(detectLocationInText("")).toBe(null);
  });

  it("requires the full canonical name (no smashed-together typos)", () => {
    expect(detectLocationInText("@KidsSanctuary")).toBe(null);
  });

  it("returns the first match in iteration order when multiple are present", () => {
    // LOCATIONS order: main_sanctuary first, then main_sanctuary_entrance, then kd_ellis_hall...
    expect(
      detectLocationInText("@KD Ellis Hall and @Main Sanctuary")
    ).toBe("main_sanctuary");
  });
});

describe("expandLocationTags", () => {
  it("replaces a single @-tag with the 📍 pin form", () => {
    expect(expandLocationTags("intruder at @Kids Sanctuary")).toBe(
      "intruder at 📍 Kids Sanctuary"
    );
  });

  it("replaces multiple @-tags in one message", () => {
    expect(
      expandLocationTags("@Main Sanctuary and @KD Ellis Hall both clear")
    ).toBe("📍 Main Sanctuary and 📍 KD Ellis Hall both clear");
  });

  it("normalizes case to canonical name", () => {
    expect(expandLocationTags("meet at @main sanctuary")).toBe(
      "meet at 📍 Main Sanctuary"
    );
    expect(expandLocationTags("@PARKING LOT BACK now")).toBe(
      "📍 Parking Lot Back now"
    );
  });

  it("leaves text unchanged when no tags match", () => {
    expect(expandLocationTags("just a message")).toBe("just a message");
    expect(expandLocationTags("")).toBe("");
    expect(expandLocationTags("@unknown place")).toBe("@unknown place");
  });
});

describe("formatTimestamp", () => {
  it("returns just time for today's messages (no separator)", () => {
    const result = formatTimestamp(new Date().toISOString());
    expect(result).not.toContain("·");
    expect(result).not.toContain("Yesterday");
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("prefixes 'Yesterday' for messages from yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatTimestamp(yesterday.toISOString())).toMatch(/^Yesterday · /);
  });

  it("prepends month + day for older same-year dates", () => {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const result = formatTimestamp(tenDaysAgo.toISOString());
    expect(result).toContain("·");
    expect(result).not.toContain("Yesterday");
  });

  it("includes year for cross-year dates", () => {
    const lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(formatTimestamp(lastYear.toISOString())).toMatch(/\d{4}/);
  });
});

describe("nearestLocationTo", () => {
  const fixture: Location[] = [
    { slug: "main_sanctuary", name: "Main Sanctuary", latitude: 0, longitude: 0 },
    { slug: "kids_sanctuary", name: "Kids Sanctuary", latitude: 1, longitude: 1 },
    { slug: "kd_ellis_hall", name: "KD Ellis Hall", latitude: -1, longitude: -1 },
  ];

  it("picks the closest location by squared-degree distance", () => {
    expect(nearestLocationTo(0.1, 0.1, fixture)).toBe("main_sanctuary");
    expect(nearestLocationTo(0.9, 0.9, fixture)).toBe("kids_sanctuary");
    expect(nearestLocationTo(-2, -2, fixture)).toBe("kd_ellis_hall");
  });

  it("ignores locations without coords", () => {
    const mixed: Location[] = [
      { slug: "main_sanctuary", name: "Main Sanctuary" }, // no coords
      { slug: "kids_sanctuary", name: "Kids Sanctuary", latitude: 5, longitude: 5 },
    ];
    expect(nearestLocationTo(0, 0, mixed)).toBe("kids_sanctuary");
  });

  it("returns null when no location has coords", () => {
    const noCoords: Location[] = [
      { slug: "main_sanctuary", name: "Main Sanctuary" },
      { slug: "kids_sanctuary", name: "Kids Sanctuary" },
    ];
    expect(nearestLocationTo(0, 0, noCoords)).toBe(null);
  });

  it("works against the real LOCATIONS array", () => {
    // Coords from a prior PANIC at the demo church — should snap to one of
    // the demo locations, all of which are clustered near this point.
    const slug = nearestLocationTo(29.679415, -95.3939551);
    expect(slug).not.toBe(null);
  });
});

describe("teamName", () => {
  it("returns the canonical name for a known slug", () => {
    expect(teamName("worship")).toBe("Worship");
    expect(teamName("media")).toBe("Media / AV");
  });

  it("returns the slug back when unknown (defensive fallback)", () => {
    expect(teamName("unknown_team")).toBe("unknown_team");
  });
});
