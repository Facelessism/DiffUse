import React from "react";
import Button, { type ButtonProps } from "./Button";
import { Legacy } from "./Legacy";

export function App(props: Partial<ButtonProps>) {
  return (
    <main>
      <Button label="go" onClick={() => undefined} />
      <Legacy />
    </main>
  );
}
