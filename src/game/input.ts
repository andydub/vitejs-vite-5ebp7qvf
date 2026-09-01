import type { Controls } from './car'

/** Teclado + botones táctiles → controles del auto. */
export class InputManager {
  private keys = new Set<string>()
  private pressed = new Set<string>() // pulsaciones pendientes (una por keydown)
  touch = { left: false, right: false, gas: false, brake: false, reset: false }

  attach() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault()
    if (!e.repeat) this.pressed.add(e.key.toLowerCase())
    this.keys.add(e.key.toLowerCase())
  }
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase())
  }
  private onBlur = () => {
    this.keys.clear()
    this.pressed.clear()
  }

  /** Consume una pulsación pendiente de la tecla dada. */
  private consumePress(key: string): boolean {
    if (this.pressed.has(key)) {
      this.pressed.delete(key)
      return true
    }
    return false
  }

  private has(...names: string[]) {
    return names.some((n) => this.keys.has(n))
  }

  /** Simula la pulsación de C desde un botón en pantalla. */
  pressCamera() {
    this.pressed.add('c')
  }

  /** Devuelve true una sola vez por pulsación de C (cambiar cámara). */
  consumeCamera(): boolean {
    return this.consumePress('c')
  }

  /** Devuelve true una sola vez por pulsación de R. */
  consumeReset(): boolean {
    if (this.touch.reset) {
      this.touch.reset = false
      return true
    }
    return this.consumePress('r')
  }

  read(): Controls {
    const gas = this.has('arrowup', 'w') || this.touch.gas
    const brake = this.has('arrowdown', 's', ' ') || this.touch.brake
    const left = this.has('arrowleft', 'a') || this.touch.left
    const right = this.has('arrowright', 'd') || this.touch.right
    return {
      throttle: gas ? 1 : 0,
      brake: brake ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
    }
  }
}
