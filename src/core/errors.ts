export class DomainError extends Error { constructor(public code:string,message:string){super(message)} }
export const assertOrThrow:(condition:unknown,code:string,message:string)=>asserts condition=(condition,code,message)=>{if(!condition) throw new DomainError(code,message)};
