/**
 * Minimal stroke icon set for the Livy broadcast console.
 * All icons default to aria-hidden so labels supply accessible names.
 */
import type { SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

const base: SVGProps<SVGSVGElement> = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true'
}

export const IconRadio = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <path d="M8.5 15.5a5 5 0 0 1 0-7" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M5.5 18.5a9.2 9.2 0 0 1 0-13" />
    <path d="M18.5 5.5a9.2 9.2 0 0 1 0 13" />
  </svg>
)

export const IconDial = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 10h10" />
    <path d="M12 7v6" />
    <circle cx="8" cy="16" r="1.2" />
    <circle cx="16" cy="16" r="1.2" />
  </svg>
)

export const IconWave = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
  </svg>
)

export const IconSeams = IconWave

export const IconSliders = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="17" r="2" />
  </svg>
)

export const IconLyrics = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M4 6h14M4 11h10M4 16h12" />
    <circle cx="19" cy="17" r="2" />
    <path d="M21 17V9l-3 1" />
  </svg>
)

export const IconSearch = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

export const IconStations = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <rect x="3" y="4" width="7" height="7" rx="1.5" />
    <rect x="14" y="4" width="7" height="7" rx="1.5" />
    <rect x="3" y="13" width="7" height="7" rx="1.5" />
    <rect x="14" y="13" width="7" height="7" rx="1.5" />
  </svg>
)

export const IconBrain = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M9.5 4a3.5 3.5 0 0 0-3.3 4.6A3.5 3.5 0 0 0 5 15a3.5 3.5 0 0 0 4.5 5H12V4H9.5Z" />
    <path d="M14.5 4a3.5 3.5 0 0 1 3.3 4.6A3.5 3.5 0 0 1 19 15a3.5 3.5 0 0 1-4.5 5H12V4h2.5Z" />
  </svg>
)

export const IconServer = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <rect x="3" y="4" width="18" height="6" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <path d="M7 7h.01M7 17h.01" />
  </svg>
)

export const IconDatabase = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
)

export const IconKey = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9M18 12v3M21 12v2" />
  </svg>
)

export const IconPlay = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" {...props}>
    <path d="M7 5.5v13l11-6.5-11-6.5Z" />
  </svg>
)

export const IconStop = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
)

export const IconVolume = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M4 10v4h4l5 4V6L8 10H4Z" />
    <path d="M16.5 9.5a4 4 0 0 1 0 5" />
    <path d="M19 7a7.5 7.5 0 0 1 0 10" />
  </svg>
)

export const IconMute = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M4 10v4h4l5 4V6L8 10H4Z" />
    <path d="m17 9 5 6M22 9l-5 6" />
  </svg>
)

export const IconSkip = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M5 6v12l9-6-9-6Z" fill="currentColor" stroke="none" />
    <path d="M18 6v12" />
  </svg>
)

export const IconSun = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
)

export const IconMoon = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
)

export const IconMenu = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)

export const IconX = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const IconRefresh = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} {...props}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
)
