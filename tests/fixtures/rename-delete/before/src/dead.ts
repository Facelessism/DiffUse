function helperOne(): number {
  return 1;
}

function helperTwo(): number {
  return helperOne() + 1;
}

export function keepMe(): number {
  return helperTwo();
}
