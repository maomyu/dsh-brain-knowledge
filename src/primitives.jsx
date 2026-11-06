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

export function Modal({ open, title, closeLabel, onClose, className, contentClassName, children }) {
  const dialog = React.useRef(null)
  React.useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  return <dialog ref={dialog} className={className} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose() }}>
    <div className={contentClassName}>
      <header className="bk-dialog-header"><strong>{title}</strong>
        <Button onClick={onClose}>{closeLabel ?? '关闭'}</Button></header>
      {children}
    </div>
  </dialog>
}
