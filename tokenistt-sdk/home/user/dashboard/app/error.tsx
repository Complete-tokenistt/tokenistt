"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div style={{ padding: 40, textAlign: "center" }}>
      <h2>Something went wrong!</h2>
      <button type="button" onClick={() => reset()} className="btn btn-violet btn-sm" style={{ marginTop: 12 }}>
        Try again
      </button>
    </div>
  );
}
