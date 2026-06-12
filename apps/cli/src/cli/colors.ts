const NO_COLOR = !!process.env.NO_COLOR

function supportsColor(stream: NodeJS.WriteStream): boolean {
  return !NO_COLOR && !!stream.isTTY
}

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const

type ColorKey = keyof typeof CODES
const EMPTY: Record<ColorKey, string> = Object.fromEntries(
  Object.keys(CODES).map((key) => [key, '']),
) as Record<ColorKey, string>

export const colors = supportsColor(process.stdout) ? CODES : EMPTY

export const stderrColors = supportsColor(process.stderr) ? CODES : EMPTY
