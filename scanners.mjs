// Why: Centralises scanner device registry and resolution logic so it can be imported
//      by both index.mjs (production) and unit tests without loading the full MCP server.
// What: Exports SCANNER_DEVICES, DEFAULT_SCANNER_KEY, and resolveScanner().
// Test: Import this module directly; call resolveScanner with known aliases and assert
//       the correct device record is returned; call with an unknown name and assert throw.

// Why: Centralises all per-device eSCL settings so new scanners can be added in one place
//      without touching any function bodies.
// What: Maps canonical keys to { label, esclBase, aliases }. esclBase is the HTTP root of
//       the eSCL service (no trailing slash, no /eSCL path segment).
//       Aliases are matched case-insensitively by resolveScanner().
// Test: Verify SCANNER_DEVICES.canon.esclBase defaults to 'http://192.168.1.141';
//       set CANON_ESCL_BASE='http://10.0.0.1' and verify it overrides the default.
export const SCANNER_DEVICES = {
  canon: {
    label: 'Canon MF741C',
    esclBase: process.env.CANON_ESCL_BASE || 'http://192.168.1.141',
    aliases: ['canon', 'mf741c', '741c', '741', 'canon-mf741c'],
  },
  hp: {
    label: 'HP OfficeJet 5740',
    esclBase: process.env.HP_ESCL_BASE || 'http://192.168.1.183:8080',
    aliases: ['hp', 'hp 5000', 'hp5000', 'officejet', '5740', '5000', 'hp-officejet-5740'],
  },
};

export const DEFAULT_SCANNER_KEY = process.env.DEFAULT_SCANNER || 'canon';

// Why: Provides a single look-up point so every scan tool uses identical resolution
//      logic — callers pass whatever name the user typed and get back a device object.
// What: Case-insensitively matches `name` against SCANNER_DEVICES keys and aliases.
//       Returns { key, label, esclBase } on success, throws with a clear options list on failure.
// Test: resolveScanner('canon') → { key:'canon', ... };
//       resolveScanner('HP 5000') → { key:'hp', ... };
//       resolveScanner('OfficeJet') → { key:'hp', ... };
//       resolveScanner('xerox') throws an error listing 'canon', 'hp'.
export function resolveScanner(name) {
  const needle = (name ?? DEFAULT_SCANNER_KEY).toLowerCase().trim();
  for (const [key, device] of Object.entries(SCANNER_DEVICES)) {
    if (key === needle || device.aliases.some((a) => a.toLowerCase() === needle)) {
      return { key, label: device.label, esclBase: device.esclBase };
    }
  }
  const validOptions = Object.entries(SCANNER_DEVICES)
    .map(([k, d]) => `${k} (aliases: ${d.aliases.join(', ')})`)
    .join('; ');
  throw new Error(
    `Unknown scanner "${name}". Valid options: ${validOptions}. ` +
      `Default (omit parameter): ${DEFAULT_SCANNER_KEY}`
  );
}
