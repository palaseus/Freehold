export const allowedGet: RegExp[];
export const allowedPost: RegExp[];
export function routeAllowed(method: string, resource: string): boolean;
