/** Small, plain line icons — one path each, no icon font, no dependency. */
const base = (props) => ({
  width: props.size ?? 18,
  height: props.size ?? 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: props.weight ?? 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
})

export const IconDashboard = (props) => (
  <svg {...base(props)}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
)

export const IconRadio = (props) => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
  </svg>
)

export const IconLyrics = (props) => (
  <svg {...base(props)}>
    <path d="M4 6h16M4 11h12M4 16h8" />
    <path d="M17 20v-4.5l3-1.5V19" />
  </svg>
)

export const IconSearch = (props) => (
  <svg {...base(props)}>
    <circle cx="11" cy="11" r="6" />
    <path d="m16 16 4 4" />
  </svg>
)

export const IconFilters = (props) => (
  <svg {...base(props)}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </svg>
)

export const IconSeams = (props) => (
  <svg {...base(props)}>
    <path d="M3 12h3l2-6 3 12 3-9 2 3h5" />
  </svg>
)

export const IconModels = (props) => (
  <svg {...base(props)}>
    <circle cx="5" cy="7" r="1.8" />
    <circle cx="5" cy="17" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="7" r="1.8" />
    <circle cx="19" cy="17" r="1.8" />
    <path d="M6.6 8.1 10.4 11M6.6 15.9 10.4 13M13.6 11l3.8-3M13.6 13l3.8 3" />
  </svg>
)

export const IconOps = (props) => (
  <svg {...base(props)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 2.5 2.5L7 14M12.5 15H17" />
  </svg>
)

export const IconPlay = (props) => (
  <svg {...base(props)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
)

export const IconPause = (props) => (
  <svg {...base(props)} fill="currentColor" stroke="none">
    <rect x="7" y="5" width="3.5" height="14" rx="1" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
  </svg>
)

export const IconSkip = (props) => (
  <svg {...base(props)} fill="currentColor" stroke="none">
    <path d="M6 5.5v13l9-6.5z" />
    <rect x="16" y="5" width="2.5" height="14" rx="1" />
  </svg>
)

export const IconVolume = (props) => (
  <svg {...base(props)}>
    <path d="M4 9v6h3l5 4V5L7 9H4z" />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
  </svg>
)

export const IconBolt = (props) => (
  <svg {...base(props)}>
    <path d="M13 3 5 13h5l-1 8 8-10h-5l1-8z" />
  </svg>
)

export const IconKey = (props) => (
  <svg {...base(props)}>
    <circle cx="8" cy="12" r="3.2" />
    <path d="M11.2 12H20M17 12v3M14.5 12v2" />
  </svg>
)
