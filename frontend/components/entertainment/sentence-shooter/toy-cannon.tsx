import type { CSSProperties } from "react";

interface ToyCannonProps {
  angle?: number;
  className?: string;
}

export function ToyCannon({ angle = 0, className }: ToyCannonProps) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={
        {
          transform: "rotate(" + angle + "deg)",
          transformOrigin: "50% 76%",
        } as CSSProperties
      }
    >
      <svg
        className="h-full w-full overflow-visible"
        fill="none"
        viewBox="0 0 120 120"
      >
        <ellipse cx="60" cy="105" fill="#D8E8F7" rx="40" ry="9" />
        <path
          d="M36 85c0-7 5-12 12-12h24c7 0 12 5 12 12v10H36V85Z"
          fill="#4E7FD2"
          stroke="#264D99"
          strokeWidth="4"
        />
        <path
          d="M49 76V34c0-6 5-11 11-11s11 5 11 11v42H49Z"
          fill="#63C7F2"
          stroke="#276FAE"
          strokeWidth="4"
        />
        <path
          d="M47 32c0-4 3-7 7-7h12c4 0 7 3 7 7v7H47v-7Z"
          fill="#F8D763"
          stroke="#C88A18"
          strokeWidth="4"
        />
        <circle
          cx="60"
          cy="83"
          r="12"
          fill="#F8D763"
          stroke="#C88A18"
          strokeWidth="4"
        />
        <path
          d="m60 76 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L60 76Z"
          fill="white"
        />
        <path
          d="m29 38 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z"
          fill="#F8D763"
        />
        <circle cx="93" cy="52" r="5" fill="#F4A1C8" />
        <circle cx="29" cy="72" r="3" fill="#63C7F2" />
      </svg>
    </div>
  );
}
