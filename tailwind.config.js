/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 主题由 <html data-theme="light|dark"> 驱动（DESIGN-TOKENS §5）
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"Noto Sans SC Variable"',
          '"PingFang SC"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"Cascadia Code"', '"Consolas"', '"SF Mono"', 'monospace'],
      },
      colors: {
        /* 语义色彩令牌（CSS 变量驱动，见 src/styles.css） */
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          2: 'rgb(var(--color-surface-2) / <alpha-value>)',
          3: 'rgb(var(--color-surface-3) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--color-border) / <alpha-value>)',
          strong: 'rgb(var(--color-border-strong) / <alpha-value>)',
        },
        fg: {
          DEFAULT: 'rgb(var(--color-fg) / <alpha-value>)',
          secondary: 'rgb(var(--color-fg-secondary) / <alpha-value>)',
          muted: 'rgb(var(--color-fg-muted) / <alpha-value>)',
          disabled: 'rgb(var(--color-fg-disabled) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / <alpha-value>)',
          hover: 'rgb(var(--color-primary-hover) / <alpha-value>)',
          soft: 'rgb(var(--color-primary-soft) / <alpha-value>)',
          on: 'rgb(var(--color-on-primary) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--color-danger) / <alpha-value>)',
          strong: 'rgb(var(--color-danger-strong) / <alpha-value>)',
        },
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)',
        /* 品牌蓝：Phase 0 期间页面迁移过渡保留，语义 token 优先 */
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
      },
      fontSize: {
        meta: ['12px', { lineHeight: '16px' }],
        secondary: ['13px', { lineHeight: '20px' }],
        body: ['14px', { lineHeight: '21px' }],
        section: ['18px', { lineHeight: '26px', fontWeight: '600' }],
        page: ['26px', { lineHeight: '34px', letterSpacing: '-0.025em', fontWeight: '600' }],
        metric: ['24px', { lineHeight: '30px', fontWeight: '600' }],
      },
      height: {
        xs: '28px',
        sm: '32px',
        md: '36px',
        lg: '40px',
        control: '36px',
      },
      spacing: {
        0.5: '2px',
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        5: '20px',
        6: '24px',
        8: '32px',
        10: '40px',
      },
      borderRadius: {
        control: '8px',
        card: '14px',
        overlay: '14px',
      },
      boxShadow: {
        overlay: '0 10px 30px -12px rgb(2 6 23 / 0.35)',
        toast: '0 8px 24px -12px rgb(2 6 23 / 0.30)',
      },
      transitionDuration: {
        micro: '120ms',
        state: '180ms',
        overlay: '240ms',
      },
      zIndex: {
        dropdown: '20',
        overlay: '40',
        modal: '50',
        toast: '60',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-out': { from: { opacity: '1' }, to: { opacity: '0' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'fade-out': 'fade-out 120ms ease-in',
        'slide-up': 'slide-up 180ms ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
