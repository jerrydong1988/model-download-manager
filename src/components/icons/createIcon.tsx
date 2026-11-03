import { forwardRef } from 'react'
import { createLucideIcon, type IconNode, type LucideIcon, type LucideProps } from 'lucide-react'
import catalog from './catalog.json'

export type IconName = keyof typeof catalog

/** Shared geometry, stroke and accessibility defaults for every interface icon. */
export function createIcon(name: IconName): LucideIcon {
  const nodes = catalog[name].nodes as unknown as IconNode
  const glyph = createLucideIcon(name, nodes.map<IconNode[number]>(([tag, attributes], index) =>
    [tag, { ...attributes, key: `${name}-${index}` }],
  ))
  const Glyph = glyph
  const Icon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => {
    const { strokeWidth = 1.75, className, ...rest } = props
    const named = Boolean(props['aria-label'] || props['aria-labelledby'])
    return (
      <Glyph
        ref={ref}
        aria-hidden={named ? undefined : true}
        role={named ? 'img' : undefined}
        focusable="false"
        {...rest}
        strokeWidth={strokeWidth}
        className={className}
      />
    )
  })
  Icon.displayName = `Mdm${name}`
  return Icon
}
