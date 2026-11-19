// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/RenderErrorBoundary.tsx (unchanged).
import { Component, type ReactNode } from "react";

interface RenderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly resetKeys?: ReadonlyArray<unknown>;
}

interface RenderErrorBoundaryState {
  readonly failed: boolean;
  readonly resetKeys?: ReadonlyArray<unknown> | undefined;
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  override state = { failed: false, resetKeys: this.props.resetKeys };

  static getDerivedStateFromProps(
    { resetKeys }: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ) {
    if (
      resetKeys?.length !== state.resetKeys?.length ||
      resetKeys?.some((key, index) => !Object.is(key, state.resetKeys?.[index]))
    ) {
      return { failed: false, resetKeys };
    }
    return null;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
