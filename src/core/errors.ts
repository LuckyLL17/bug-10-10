export class DomainError extends Error { constructor(public code:string,message:string){super(message)} }
export function assertOrThrow(condition:unknown,code:string,message:string):asserts condition{
  if(!condition) throw new DomainError(code,message);
}
