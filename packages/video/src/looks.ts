// The built-in look library. Each look is one GLSL file whose header
// describes it:
//
//   // @look vein-tunnel
//   // @title Vein Tunnel
//   // @fits drop, heavy
//   // @mood dark, heavy, organic, pulsing
//   // @desc Flying down a black tunnel of glowing veins...
//   // @param thickLo 22   vein sharpness when bass is quiet
//
// and one function, vec3 look(vec2 uv), that reads its parameters as P_name.

export interface LookParam {
  name: string
  /** One to four components; the length sets the GLSL type. */
  default: number[]
  description: string
}

export interface Look {
  id: string
  title: string
  fits: string[]
  mood: string[]
  description: string
  /** Layer looks add on top of a scene look and are mostly black. */
  layer: boolean
  params: LookParam[]
  code: string
}

const sources = import.meta.glob('./glsl/looks/*.glsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export function parseLook(fileName: string, code: string): Look {
  const look: Look = { id: fileName.replace(/^.*\//, '').replace(/\.glsl$/, ''), title: '', fits: [], mood: [], description: '', layer: false, params: [], code }
  for (const line of code.split(/\r?\n/)) {
    const match = /^\/\/\s*@(\w+)\s+(.*)$/.exec(line.trim())
    if (!match) continue
    const [, key, rest] = match
    const value = rest.trim()
    if (key === 'param') {
      const [name, values, ...description] = value.split(/\s+/)
      look.params.push({ name, default: values.split(',').map(Number), description: description.join(' ') })
    } else if (key === 'look') look.id = value
    else if (key === 'title') look.title = value
    else if (key === 'fits') {
      look.fits = value.replace(/^layer:\s*/, '').split(/,\s*/)
      look.layer = value.startsWith('layer:')
    } else if (key === 'mood') look.mood = value.split(/,\s*/)
    else if (key === 'desc') look.description = value
  }
  look.title ||= look.id
  return look
}

export const LOOKS: readonly Look[] = Object.entries(sources)
  .map(([path, code]) => parseLook(path, code))
  .sort((a, z) => Number(a.layer) - Number(z.layer) || a.title.localeCompare(z.title))

export const lookById = (id: string): Look | undefined => LOOKS.find((look) => look.id === id)
