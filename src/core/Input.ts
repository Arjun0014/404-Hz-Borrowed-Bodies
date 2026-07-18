/** Keyboard + pointer-lock mouse input. Mouse deltas accumulate until consumed. */
export class Input {
  pointerLocked = false;
  /** Accumulated mouse deltas; read then call clearMouse() once per frame. */
  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  onPointerLockChange: (locked: boolean) => void = () => {};

  private keys = new Set<string>();
  /** Left-click attack edge, latched until consumed once per frame. */
  private attackLatched = false;
  private readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
      if (!this.pointerLocked) this.keys.clear();
      this.onPointerLockChange(this.pointerLocked);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    window.addEventListener('wheel', (e) => {
      if (this.pointerLocked) this.wheelDelta += e.deltaY;
    });

    // Left-click = attack (only while locked, so the click that grabs pointer
    // lock or dismisses a menu never fires a bite).
    window.addEventListener('mousedown', (e) => {
      if (this.pointerLocked && e.button === 0) this.attackLatched = true;
    });
  }

  /** True once per left-click; consumes the latch. */
  consumeAttack(): boolean {
    const a = this.attackLatched;
    this.attackLatched = false;
    return a;
  }

  requestLock(): void {
    this.el.requestPointerLock();
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** 1 if a is held, -1 if b is held, 0 otherwise. */
  axis(a: string, b: string): number {
    return (this.isDown(a) ? 1 : 0) - (this.isDown(b) ? 1 : 0);
  }

  clearMouse(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}
