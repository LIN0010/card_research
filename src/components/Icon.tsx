import type { CSSProperties } from 'react'

const paths = {
  cards: 'M7 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 3H3v13a2 2 0 0 0 2 2m4-14h7M9 17h7m-3.5-7 1 2 2 .5-1.5 1.5.3 2-1.8-1-1.8 1 .3-2L10 12.5l2-.5Z',
  book: 'M4 3h14a2 2 0 0 1 2 2v16H5a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm2 0v18M2 17h18M10 7h6m-6 4h4',
  shop: 'M3 10v11h18V10M2 10l2-7h16l2 7M2 10a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0M9 21v-7h6v7',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm8 4 8 8-8 8',
  swap: 'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
  more: 'M5 11h.01M12 11h.01M19 11h.01M5 12h.01M12 12h.01M19 12h.01',
  check: 'm5 12 4 4L19 6',
  refresh: 'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5',
  logout: 'M10 4H4v16h6m4-12 4 4-4 4m-7-4h11',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  undo: 'm8 5-5 5 5 5M3 10h10a7 7 0 0 1 7 7v2',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-7 0v6',
  close: 'm6 6 12 12M6 18 18 6',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 20, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`icon ${className}`} style={style}><path d={paths[name]} /></svg>
}
