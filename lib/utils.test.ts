import { describe, it, expect } from "vitest";
import {
  alertTone,
  detectLocationInText,
  expandLocationTags,
  formatTimestamp,
  nearestLocationTo,
  parseOptionalCoordinate,
  teamName,
  validateCoordinateValue,
} from "./utils";
import { DEFAULT_LOCATIONS, DEFAULT_TEAMS, type Location } from "./supabase";

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
    expect(alertTone("a panic happened in the kids wing")).toBe("beep");
    expect(alertTone("astand down")).toBe("beep");
    expect(alertTone("")).toBe("beep");
  });
});

describe("detectLocationInText", () => {
  it("returns the matching location slug", () => {
    expect(
      detectLocationInText("intruder at @Kids Sanctuary", DEFAULT_LOCATIONS)
    ).toBe("kids_sanctuary");
    expect(
      detectLocationInText("meet at @Main Sanctuary", DEFAULT_LOCATIONS)
    ).toBe("main_sanctuary");
    expect(
      detectLocationInText("@Fellowship Hall fire", DEFAULT_LOCATIONS)
    ).toBe("fellowship_hall");
  });

  it("is case-insensitive", () => {
    expect(
      detectLocationInText("@kids sanctuary now", DEFAULT_LOCATIONS)
    ).toBe("kids_sanctuary");
    expect(detectLocationInText("@MAIN SANCTUARY", DEFAULT_LOCATIONS)).toBe(
      "main_sanctuary"
    );
    expect(
      detectLocationInText("Help @Parking Lot Front", DEFAULT_LOCATIONS)
    ).toBe("parking_lot_front");
  });

  it("returns null when no @-tag matches a known location", () => {
    expect(detectLocationInText("just a message", DEFAULT_LOCATIONS)).toBe(null);
    expect(detectLocationInText("@somewhere else", DEFAULT_LOCATIONS)).toBe(
      null
    );
    expect(detectLocationInText("", DEFAULT_LOCATIONS)).toBe(null);
  });

  it("requires the full canonical name (no smashed-together typos)", () => {
    expect(detectLocationInText("@KidsSanctuary", DEFAULT_LOCATIONS)).toBe(
      null
    );
  });

  it("matches longer names first so 'Main Sanctuary Entrance' wins over 'Main Sanctuary'", () => {
    expect(
      detectLocationInText(
        "intruder at @Main Sanctuary Entrance",
        DEFAULT_LOCATIONS
      )
    ).toBe("main_sanctuary_entrance");
  });
});

describe("expandLocationTags", () => {
  it("replaces a single @-tag with the 📍 pin form", () => {
    expect(
      expandLocationTags("intruder at @Kids Sanctuary", DEFAULT_LOCATIONS)
    ).toBe("intruder at 📍 Kids Sanctuary");
  });

  it("replaces multiple @-tags in one message", () => {
    expect(
      expandLocationTags(
        "@Main Sanctuary and @Fellowship Hall both clear",
        DEFAULT_LOCATIONS
      )
    ).toBe("📍 Main Sanctuary and 📍 Fellowship Hall both clear");
  });

  it("normalizes case to canonical name", () => {
    expect(
      expandLocationTags("meet at @main sanctuary", DEFAULT_LOCATIONS)
    ).toBe("meet at 📍 Main Sanctuary");
    expect(expandLocationTags("@PARKING LOT BACK now", DEFAULT_LOCATIONS)).toBe(
      "📍 Parking Lot Back now"
    );
  });

  it("leaves text unchanged when no tags match", () => {
    expect(expandLocationTags("just a message", DEFAULT_LOCATIONS)).toBe(
      "just a message"
    );
    expect(expandLocationTags("", DEFAULT_LOCATIONS)).toBe("");
    expect(expandLocationTags("@unknown place", DEFAULT_LOCATIONS)).toBe(
      "@unknown place"
    );
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
    { slug: "main_sanctuary", name: "Main Sanctuary", latitude: 29.6794, longitude: -95.394 },
    { slug: "kids_sanctuary", name: "Kids Sanctuary", latitude: 29.6804, longitude: -95.394 },
    { slug: "fellowship_hall", name: "Fellowship Hall", latitude: 29.6784, longitude: -95.394 },
  ];

  it("picks the closest location within the radius", () => {
    expect(nearestLocationTo(29.67945, -95.394, fixture, 500)).toBe(
      "main_sanctuary"
    );
    expect(nearestLocationTo(29.6803, -95.394, fixture, 500)).toBe(
      "kids_sanctuary"
    );
    expect(nearestLocationTo(29.6785, -95.394, fixture, 500)).toBe(
      "fellowship_hall"
    );
  });

  it("returns null when sender is far beyond every location's radius", () => {
    expect(nearestLocationTo(30.6447, -91.1794, fixture)).toBe(null);
  });

  it("respects the maxMeters bound", () => {
    expect(nearestLocationTo(29.69, -95.394, fixture, 500)).toBe(null);
    expect(nearestLocationTo(29.69, -95.394, fixture, 1500)).toBe(
      "kids_sanctuary"
    );
  });

  it("ignores locations without coords", () => {
    const mixed: Location[] = [
      { slug: "main_sanctuary", name: "Main Sanctuary" },
      { slug: "kids_sanctuary", name: "Kids Sanctuary", latitude: 29.6794, longitude: -95.394 },
    ];
    expect(nearestLocationTo(29.6794, -95.394, mixed)).toBe("kids_sanctuary");
  });

  it("returns null when no location has coords", () => {
    const noCoords: Location[] = [
      { slug: "main_sanctuary", name: "Main Sanctuary" },
      { slug: "kids_sanctuary", name: "Kids Sanctuary" },
    ];
    expect(nearestLocationTo(0, 0, noCoords)).toBe(null);
  });
});

describe("teamName", () => {
  it("returns the canonical name for a known slug", () => {
    expect(teamName("worship", DEFAULT_TEAMS)).toBe("Worship");
    expect(teamName("media", DEFAULT_TEAMS)).toBe("Media / AV");
  });

  it("returns the slug back when unknown (defensive fallback)", () => {
    expect(teamName("unknown_team", DEFAULT_TEAMS)).toBe("unknown_team");
  });
});

describe("coordinate validation", () => {
  it("parses blank optional coordinates as null", () => {
    expect(parseOptionalCoordinate("", "latitude")).toBe(null);
    expect(parseOptionalCoordinate("  ", "longitude")).toBe(null);
  });

  it("parses valid latitude and longitude values", () => {
    expect(parseOptionalCoordinate("29.6794", "latitude")).toBe(29.6794);
    expect(parseOptionalCoordinate("-95.394", "longitude")).toBe(-95.394);
  });

  it("rejects non-numeric coordinates", () => {
    expect(() => parseOptionalCoordinate("north", "latitude")).toThrow(
      "Latitude and longitude must be numbers."
    );
  });

  it("rejects out-of-range coordinate values", () => {
    expect(() => validateCoordinateValue(91, "latitude")).toThrow(
      "Latitude must be between -90 and 90."
    );
    expect(() => validateCoordinateValue(-181, "longitude")).toThrow(
      "Longitude must be between -180 and 180."
    );
  });
});
