// MOTION
// closed-form, so the lean and turn are exactly as smooth at 30 fps as at 144

// x(t) = e^(-g t) (a cos wt + b sin wt), seeded from a position and a velocity
export class Osc {
  private a = 0;
  private b = 0;
  private t0 = 0;

  constructor(
    private w: number,
    private g: number,
    private max = Infinity,
  ) {}

  set(t: number, x: number, v: number) {
    this.t0 = t;
    this.a = x;
    this.b = (v + this.g * x) / this.w;
    // a hard flick keeps where it was let go and loses the extra speed
    const amp = Math.hypot(this.a, this.b);
    if (amp > this.max) {
      const room = Math.sqrt(Math.max(0, this.max * this.max - this.a * this.a));
      this.b = Math.sign(this.b) * room;
    }
  }

  x(t: number) {
    const s = t - this.t0;
    const e = Math.exp(-this.g * s);
    return e * (this.a * Math.cos(this.w * s) + this.b * Math.sin(this.w * s));
  }

  v(t: number) {
    const s = t - this.t0;
    const e = Math.exp(-this.g * s);
    const c = Math.cos(this.w * s);
    const n = Math.sin(this.w * s);
    return e * ((this.w * this.b - this.g * this.a) * c - (this.g * this.b + this.w * this.a) * n);
  }

  amp(t: number) {
    return Math.exp(-this.g * (t - this.t0)) * Math.hypot(this.a, this.b);
  }
}

// critically damped follow, exact for any dt: the dragged crystal trails the finger a touch
export class Follow {
  x = 0;
  v = 0;

  constructor(private w: number) {}

  step(target: number, dt: number) {
    const d = this.x - target;
    const k = this.v + this.w * d;
    const e = Math.exp(-this.w * dt);
    this.x = target + (d + k * dt) * e;
    this.v = (this.v - this.w * k * dt) * e;
  }
}

// ORIENT
// the swing across the wall, then the lean toward it, then the twist about the chain. as
// plain rotations one after another, so a swing over the top and round wraps cleanly.
// r is column-major, local to world
export function orient(r: Float32Array, ax: number, az: number, twist: number) {
  const cz = Math.cos(ax);
  const sz = Math.sin(ax);
  const cx = Math.cos(-az);
  const sx = Math.sin(-az);
  // rz(ax) * rx(-az), row-major
  const m00 = cz;
  const m01 = -sz * cx;
  const m02 = sz * sx;
  const m10 = sz;
  const m11 = cz * cx;
  const m12 = -cz * sx;
  const m20 = 0;
  const m21 = sx;
  const m22 = cx;
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  r[0] = m00 * ct - m02 * st;
  r[1] = m10 * ct - m12 * st;
  r[2] = m20 * ct - m22 * st;
  r[3] = m01;
  r[4] = m11;
  r[5] = m21;
  r[6] = m00 * st + m02 * ct;
  r[7] = m10 * st + m12 * ct;
  r[8] = m20 * st + m22 * ct;
}
