/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design tokens (src/ui/kit/tokens.css). Prefer these names over Tailwind's palette.
      colors: {
        canvas: 'var(--canvas)',
        glass: {
          DEFAULT: 'var(--glass-fill)',
          strong: 'var(--glass-fill-strong)',
          solid: 'var(--glass-fill-solid)',
          edge: 'var(--glass-edge)',
          highlight: 'var(--glass-highlight)',
        },
        ink: {
          DEFAULT: 'var(--ink)',
          muted: 'var(--ink-muted)',
          faint: 'var(--ink-faint)',
        },
        'on-ink': 'var(--on-ink)',
        fill: {
          hover: 'var(--fill-hover)',
          selected: 'var(--fill-selected)',
          field: 'var(--fill-field)',
          track: 'var(--fill-track)',
          well: 'var(--fill-well)',
        },
        record: 'var(--record)',
        danger: 'var(--danger)',
        scrim: 'var(--scrim)',
        'logo-note': 'var(--logo-note)',
      },
      fontFamily: {
        sans: ['Geist Variable', 'Geist', 'Hiragino Sans', 'Noto Sans JP', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        caption: ['12px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '18px' }],
        label: ['13px', { lineHeight: '18px', fontWeight: '500' }],
        heading: ['13px', { lineHeight: '18px', fontWeight: '600' }],
        title: ['15px', { lineHeight: '20px', fontWeight: '600', letterSpacing: '-0.01em' }],
        display: ['18px', { lineHeight: '24px', fontWeight: '600' }],
      },
      borderRadius: {
        field: '8px',
        tab: '9px',
        panel: '18px',
        round: '999px',
      },
      spacing: {
        'control-sm': '28px',
        control: '36px',
        'icon-btn': '40px',
        play: '40px',
        bar: '52px',
        pill: '60px',
        panel: '344px',
        card: '252px',
        'touch-min': '44px',
      },
      boxShadow: {
        glass: 'var(--shadow-glass)',
        knob: 'var(--shadow-knob)',
      },
    },
  },
  plugins: [require('tailwindcss-react-aria-components')],
}
