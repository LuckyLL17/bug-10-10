export interface Clock { now():number }
export class SystemClock implements Clock { now(){ return Date.now(); } }
