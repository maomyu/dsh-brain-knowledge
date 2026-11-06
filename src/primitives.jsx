import React from 'react'

export function Button({ variant, size, className, ...props }) {
  return <button type="button" className={['bk-workflow-button', className].filter(Boolean).join(' ')}
    data-variant={variant} data-size={size} {...props}/>
}

export function Tag({ variant, size, className, ...props }) {
  return <span className={['bk-workflow-tag', className].filter(Boolean).join(' ')}
    data-variant={variant} data-size={size} {...props}/>
}

export const randomUUID = () => globalThis.crypto.randomUUID()
