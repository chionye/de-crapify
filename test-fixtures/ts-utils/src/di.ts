export function Injectable(): ClassDecorator {
  return () => {};
}

export function Memoize(): MethodDecorator {
  return (_target, _key, descriptor) => descriptor;
}
