import type { JavaMethod } from './types';

export function sameMethod(left: JavaMethod, right: JavaMethod | null | undefined): boolean {
  return !!right && left.owner === right.owner && left.signature === right.signature && left.kind === right.kind;
}
