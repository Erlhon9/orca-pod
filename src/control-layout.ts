export type ControlPosition = 'bottom' | 'right' | 'left' | 'auto'

export function readControlPosition(value: unknown): ControlPosition {
  return value === 'right' || value === 'left' || value === 'auto' ? value : 'bottom'
}

/** 사용자가 고른 위치는 창 폭·접힘·보기 전환에 따라 바꾸지 않는다. */
export function controlDock(position: ControlPosition, width: number, graph: boolean, open: boolean): Exclude<ControlPosition,'auto'> {
  return position === 'auto' ? graph && open && width >= 1100 ? 'right' : 'bottom' : position
}
