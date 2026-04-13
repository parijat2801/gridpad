// Mantine theme — dark, burgundy brand, Inter + JetBrains Mono, tight radii,
// badges with normal case. Adapted from colex-platform conventions.

import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Burgundy brand palette (10 shades, dark to light — Mantine convention).
const burgundy: MantineColorsTuple = [
  "#fbebee",
  "#f2cdd3",
  "#e69aa4",
  "#da6373",
  "#d0374c",
  "#cb1c35",
  "#c9072a",
  "#b20022",
  "#9f001d",
  "#8b0019",
];

export const theme = createTheme({
  primaryColor: "burgundy",
  colors: { burgundy },
  primaryShade: { light: 5, dark: 6 },
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  fontFamilyMonospace:
    "'JetBrains Mono', 'Source Code Pro', Menlo, monospace",
  defaultRadius: "sm",
  radius: {
    xs: "2px",
    sm: "3px",
    md: "4px",
    lg: "6px",
    xl: "8px",
  },
  components: {
    Badge: {
      styles: {
        root: { textTransform: "none" as const },
      },
    },
  },
});
