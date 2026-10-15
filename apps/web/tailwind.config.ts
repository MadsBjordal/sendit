import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand colours come from CSS variables (globals.css) so a rename/rebrand is one place
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          dark: 'rgb(var(--brand-dark) / <alpha-value>)',
          soft: 'rgb(var(--brand-soft) / <alpha-value>)',
        },
        ink: { DEFAULT: '#0f172a', soft: '#475569', faint: '#94a3b8' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: { card: '0 1px 2px rgb(15 23 42 / 0.06), 0 4px 16px rgb(15 23 42 / 0.06)' },
    },
  },
  plugins: [],
} satisfies Config;
