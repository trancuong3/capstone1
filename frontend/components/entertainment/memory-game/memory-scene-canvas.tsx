"use client";

import { useEffect, useId, type ReactElement } from "react";

import { useTranslations } from "@/hooks/use-i18n";
import type {
  MemoryColorShapeCue,
  MemoryThemeKey,
  SceneObjectSpecDTO,
  SceneSpecDTO,
} from "@/types/memory-game";

export interface MemorySceneCanvasProps {
  readonly sceneSpec: SceneSpecDTO;
  readonly mode: "observe" | "peek" | "reveal";
  readonly showColorCues?: boolean;
  readonly reducedMotion?: boolean;
  readonly matchedObjectIds?: ReadonlySet<string>;
  readonly missedObjectIds?: ReadonlySet<string>;
  readonly focusedObjectId?: string | null;
  readonly onSelectObject?: (objectId: string) => void;
  readonly onSceneReady?: (sceneSeed: number) => void;
  readonly className?: string;
}

interface SpriteColors {
  readonly fill: string;
  readonly stroke: string;
  readonly light: string;
}

function renderShapeCue(
  cue: MemoryColorShapeCue,
  colors: SpriteColors,
): ReactElement {
  switch (cue) {
    case "circle":
      return (
        <circle
          cx={0}
          cy={0}
          r={6}
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.8}
        />
      );
    case "square":
      return (
        <rect
          x={-5.5}
          y={-5.5}
          width={11}
          height={11}
          rx={2}
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.8}
        />
      );
    case "star":
      return (
        <polygon
          points="0,-7 2,-2 7,-2 3,1 4.5,6.5 0,3.2 -4.5,6.5 -3,1 -7,-2 -2,-2"
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.4}
        />
      );
    case "triangle":
      return (
        <polygon
          points="0,-7 6.5,5.5 -6.5,5.5"
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.6}
        />
      );
    case "diamond":
      return (
        <polygon
          points="0,-7 6.5,0 0,7 -6.5,0"
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.6}
        />
      );
    case "hexagon":
      return (
        <polygon
          points="-4,-6 4,-6 7,0 4,6 -4,6 -7,0"
          fill={colors.fill}
          stroke="#FFFFFF"
          strokeWidth={1.6}
        />
      );
  }
}

/**
 * Renders 42 distinct Vietnamese kid-friendly vector sprites inside a normalized 100x100 local box.
 */
function renderSpriteArtwork(spriteKey: string, c: SpriteColors): ReactElement {
  switch (spriteKey) {
    // --- 1. sunny_garden (7) ---
    case "tabby_cat":
      return (
        <g>
          <path
            d="M72 72 Q90 64 85 46"
            fill="none"
            stroke={c.stroke}
            strokeWidth={6}
            strokeLinecap="round"
          />
          <ellipse
            cx={50}
            cy={66}
            rx={24}
            ry={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={50}
            cy={38}
            r={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <polygon
            points="35,28 32,12 45,22"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <polygon
            points="65,28 68,12 55,22"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M44 26 L44 31 M50 24 L50 30 M56 26 L56 31"
            stroke={c.stroke}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <circle cx={43} cy={38} r={2.8} fill="#1E293B" />
          <circle cx={57} cy={38} r={2.8} fill="#1E293B" />
          <polygon points="47,43 53,43 50,47" fill="#FF7E9D" />
          <path
            d="M45 49 Q50 53 55 49"
            fill="none"
            stroke={c.stroke}
            strokeWidth={2.2}
            strokeLinecap="round"
          />
          <path
            d="M27 42 L38 43 M27 47 L38 46 M62 43 L73 42 M62 46 L73 47"
            stroke={c.stroke}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <ellipse cx={50} cy={70} rx={12} ry={9} fill={c.light} />
        </g>
      );
    case "butterfly":
      return (
        <g>
          <ellipse
            cx={32}
            cy={38}
            rx={20}
            ry={16}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={68}
            cy={38}
            rx={20}
            ry={16}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={36}
            cy={62}
            rx={15}
            ry={13}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={64}
            cy={62}
            rx={15}
            ry={13}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle cx={30} cy={36} r={6} fill="#FFFDF5" opacity={0.85} />
          <circle cx={70} cy={36} r={6} fill="#FFFDF5" opacity={0.85} />
          <rect x={45} y={28} width={10} height={44} rx={5} fill={c.stroke} />
          <path
            d="M47 28 Q41 16 36 18 M53 28 Q59 16 64 18"
            fill="none"
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinecap="round"
          />
        </g>
      );
    case "sunflower":
      return (
        <g>
          <path
            d="M50 56 L50 88"
            stroke="#1F8A4C"
            strokeWidth={6}
            strokeLinecap="round"
          />
          <ellipse
            cx={37}
            cy={73}
            rx={11}
            ry={6}
            transform="rotate(-24 37 73)"
            fill="#34B36A"
            stroke="#11522C"
            strokeWidth={2.4}
          />
          <ellipse
            cx={63}
            cy={76}
            rx={11}
            ry={6}
            transform="rotate(24 63 76)"
            fill="#34B36A"
            stroke="#11522C"
            strokeWidth={2.4}
          />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <ellipse
              key={angle}
              cx={50}
              cy={18}
              rx={8}
              ry={14}
              transform={`rotate(${angle} 50 38)`}
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth={2.4}
            />
          ))}
          <circle
            cx={50}
            cy={38}
            r={14}
            fill="#6B3E26"
            stroke="#422212"
            strokeWidth={3}
          />
          <circle cx={45} cy={36} r={2.2} fill="#FFFDF5" />
          <circle cx={55} cy={36} r={2.2} fill="#FFFDF5" />
          <path
            d="M45 43 Q50 47 55 43"
            fill="none"
            stroke="#FFFDF5"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </g>
      );
    case "watering_can":
      return (
        <g>
          <path
            d="M34 38 C16 38 16 68 34 68"
            fill="none"
            stroke={c.stroke}
            strokeWidth={6}
            strokeLinecap="round"
          />
          <path
            d="M66 56 L84 36"
            stroke={c.fill}
            strokeWidth={9}
            strokeLinecap="round"
          />
          <path
            d="M66 56 L84 36"
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <ellipse
            cx={86}
            cy={34}
            rx={6}
            ry={9}
            transform="rotate(42 86 34)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <rect
            x={30}
            y={38}
            width={38}
            height={38}
            rx={8}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={49}
            cy={38}
            rx={15}
            ry={5}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <circle cx={49} cy={57} r={7} fill="#FFFDF5" opacity={0.8} />
        </g>
      );
    case "paper_kite":
      return (
        <g>
          <path
            d="M50 74 Q64 82 54 90 Q46 95 60 96"
            fill="none"
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinecap="round"
          />
          <polygon
            points="50,12 78,44 50,76 22,44"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <polygon points="50,12 78,44 50,44" fill={c.light} opacity={0.85} />
          <polygon points="50,44 22,44 50,76" fill={c.light} opacity={0.55} />
          <path
            d="M50 12 L50 76 M22 44 L78 44"
            stroke={c.stroke}
            strokeWidth={2.2}
          />
          <polygon points="55,83 62,80 62,87" fill={c.fill} />
        </g>
      );
    case "singing_bird":
      return (
        <g>
          <polygon
            points="22,48 10,38 14,56"
            fill={c.stroke}
            stroke={c.stroke}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <ellipse
            cx={48}
            cy={56}
            rx={24}
            ry={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={64}
            cy={38}
            r={14}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <polygon
            points="76,36 89,40 76,45"
            fill="#F59E0B"
            stroke="#92400E"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <ellipse
            cx={44}
            cy={56}
            rx={13}
            ry={8}
            transform="rotate(-12 44 56)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <circle cx={67} cy={35} r={2.8} fill="#1E293B" />
          <path
            d="M42 74 L42 84 M54 74 L54 84"
            stroke="#92400E"
            strokeWidth={3}
            strokeLinecap="round"
          />
        </g>
      );
    case "garden_ball":
      return (
        <g>
          <circle
            cx={50}
            cy={50}
            r={30}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
          />
          <path
            d="M50 20 Q65 50 50 80 Q35 50 50 20 Z"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <path
            d="M21 50 Q50 38 79 50"
            fill="none"
            stroke="#FFFDF5"
            strokeWidth={3.5}
          />
          <circle
            cx={50}
            cy={50}
            r={6}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2.2}
          />
        </g>
      );

    // --- 2. happy_classroom (7) ---
    case "open_book":
      return (
        <g>
          <path
            d="M14 28 Q32 22 50 32 Q68 22 86 28 L86 76 Q68 69 50 78 Q32 69 14 76 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M19 32 Q34 27 48 35 L48 72 Q34 65 19 71 Z"
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2}
          />
          <path
            d="M81 32 Q66 27 52 35 L52 72 Q66 65 81 71 Z"
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2}
          />
          <path
            d="M24 42 L43 44 M24 51 L43 53 M24 60 L40 61 M57 44 L76 42 M57 53 L76 51 M57 61 L72 60"
            stroke={c.stroke}
            strokeWidth={2.2}
            strokeLinecap="round"
          />
        </g>
      );
    case "pencil_cup":
      return (
        <g>
          <rect
            x={33}
            y={18}
            width={10}
            height={36}
            rx={2}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <polygon
            points="33,18 38,8 43,18"
            fill="#FDE68A"
            stroke={c.stroke}
            strokeWidth={2}
          />
          <rect
            x={55}
            y={22}
            width={10}
            height={32}
            rx={2}
            fill="#FFE074"
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <polygon
            points="55,22 60,12 65,22"
            fill="#FDE68A"
            stroke={c.stroke}
            strokeWidth={2}
          />
          <path
            d="M26 44 L74 44 L68 84 L32 84 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <rect
            x={36}
            y={56}
            width={28}
            height={12}
            rx={6}
            fill="#FFFDF5"
            opacity={0.85}
          />
        </g>
      );
    case "school_bag":
      return (
        <g>
          <path
            d="M38 26 C38 14 62 14 62 26"
            fill="none"
            stroke={c.stroke}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <rect
            x={22}
            y={26}
            width={56}
            height={56}
            rx={14}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <path
            d="M22 44 Q50 56 78 44"
            fill="none"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <rect
            x={32}
            y={55}
            width={36}
            height={18}
            rx={6}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <rect
            x={46}
            y={44}
            width={8}
            height={10}
            rx={3}
            fill="#FFE074"
            stroke={c.stroke}
            strokeWidth={2}
          />
        </g>
      );
    case "world_globe":
      return (
        <g>
          <circle
            cx={50}
            cy={44}
            r={25}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <path
            d="M34 34 Q46 28 52 38 Q46 48 36 45 Z M56 44 Q66 42 68 54 Q58 60 52 52 Z"
            fill={c.light}
          />
          <path
            d="M28 65 A28 28 0 0 0 72 65"
            fill="none"
            stroke="#92400E"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <path
            d="M50 70 L50 82 M34 84 L66 84"
            stroke="#92400E"
            strokeWidth={5}
            strokeLinecap="round"
          />
        </g>
      );
    case "wall_clock":
      return (
        <g>
          <circle
            cx={50}
            cy={50}
            r={30}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.5}
          />
          <circle
            cx={50}
            cy={50}
            r={23}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2}
          />
          <path
            d="M50 31 L50 35 M50 65 L50 69 M31 50 L35 50 M65 50 L69 50"
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinecap="round"
          />
          <path
            d="M50 50 L50 36 M50 50 L62 54"
            stroke={c.stroke}
            strokeWidth={3.4}
            strokeLinecap="round"
          />
          <circle cx={50} cy={50} r={3.5} fill={c.fill} />
        </g>
      );
    case "paper_plane":
      return (
        <g>
          <polygon
            points="12,48 86,20 68,78 46,58"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <polygon
            points="86,20 46,58 56,74"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          <path d="M12 48 L86 20" stroke={c.stroke} strokeWidth={2.4} />
        </g>
      );
    case "teddy_bear":
      return (
        <g>
          <circle
            cx={34}
            cy={24}
            r={9}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={66}
            cy={24}
            r={9}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={50}
            cy={68}
            rx={22}
            ry={20}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={50}
            cy={38}
            r={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse cx={50} cy={43} rx={9} ry={7} fill={c.light} />
          <circle cx={43} cy={35} r={2.6} fill="#1E293B" />
          <circle cx={57} cy={35} r={2.6} fill="#1E293B" />
          <ellipse cx={50} cy={41} rx={3.5} ry={2.5} fill="#422212" />
          <ellipse cx={50} cy={70} rx={11} ry={10} fill={c.light} />
        </g>
      );

    // --- 3. mid_autumn_yard (7) ---
    case "star_lantern":
      return (
        <g>
          <path
            d="M50 8 L50 20"
            stroke="#FDE68A"
            strokeWidth={3}
            strokeLinecap="round"
          />
          <circle
            cx={50}
            cy={52}
            r={28}
            fill="none"
            stroke="#FDE68A"
            strokeWidth={3}
          />
          <polygon
            points="50,18 59,40 82,40 63,54 70,76 50,62 30,76 37,54 18,40 41,40"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <circle
            cx={50}
            cy={50}
            r={9}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2}
          />
        </g>
      );
    case "rice_drum":
      return (
        <g>
          <rect
            x={22}
            y={30}
            width={56}
            height={42}
            rx={16}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={50}
            cy={32}
            rx={26}
            ry={9}
            fill="#FFF7D6"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <path
            d="M28 40 L38 64 L50 40 L62 64 L72 40"
            fill="none"
            stroke="#FFE074"
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M24 20 L46 31 M76 20 L54 31"
            stroke="#92400E"
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </g>
      );
    case "mooncake_plate":
      return (
        <g>
          <ellipse
            cx={50}
            cy={70}
            rx={36}
            ry={12}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <rect
            x={28}
            y={34}
            width={44}
            height={34}
            rx={10}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <rect
            x={35}
            y={41}
            width={30}
            height={20}
            rx={5}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2}
          />
          <circle
            cx={50}
            cy={51}
            r={5}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2}
          />
        </g>
      );
    case "jade_rabbit":
      return (
        <g>
          <ellipse
            cx={41}
            cy={20}
            rx={6}
            ry={16}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={59}
            cy={20}
            rx={6}
            ry={16}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse cx={41} cy={21} rx={3} ry={10} fill={c.light} />
          <ellipse cx={59} cy={21} rx={3} ry={10} fill={c.light} />
          <ellipse
            cx={50}
            cy={68}
            rx={20}
            ry={16}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={50}
            cy={44}
            r={16}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle cx={44} cy={42} r={2.5} fill="#1E293B" />
          <circle cx={56} cy={42} r={2.5} fill="#1E293B" />
          <circle cx={50} cy={47} r={2.5} fill="#FF7E9D" />
        </g>
      );
    case "lion_mask":
      return (
        <g>
          <circle
            cx={50}
            cy={52}
            r={28}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
          />
          <polygon
            points="50,14 57,30 43,30"
            fill="#FFE074"
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <circle
            cx={38}
            cy={46}
            r={7}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <circle
            cx={62}
            cy={46}
            r={7}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <circle cx={38} cy={46} r={3.2} fill="#1E293B" />
          <circle cx={62} cy={46} r={3.2} fill="#1E293B" />
          <path
            d="M32 62 Q50 74 68 62"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </g>
      );
    case "carp_lantern":
      return (
        <g>
          <path
            d="M50 12 L50 26"
            stroke="#FDE68A"
            strokeWidth={3}
            strokeLinecap="round"
          />
          <polygon
            points="22,52 8,36 12,68"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <ellipse
            cx={54}
            cy={52}
            rx={30}
            ry={20}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <path
            d="M40 42 Q48 52 40 62 M54 40 Q62 52 54 64"
            fill="none"
            stroke={c.light}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <circle cx={72} cy={46} r={3.2} fill="#FFFDF5" />
          <circle cx={73} cy={46} r={1.6} fill="#1E293B" />
        </g>
      );
    case "pomelo_fruit":
      return (
        <g>
          <path
            d="M50 18 L50 28"
            stroke="#6B3E26"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <ellipse
            cx={62}
            cy={22}
            rx={11}
            ry={5}
            transform="rotate(-18 62 22)"
            fill="#1F8A4C"
            stroke="#11522C"
            strokeWidth={2}
          />
          <path
            d="M50 26 C68 26 78 44 76 62 C74 78 62 84 50 84 C38 84 26 78 24 62 C22 44 32 26 50 26 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={41}
            cy={48}
            rx={6}
            ry={11}
            fill={c.light}
            opacity={0.65}
          />
        </g>
      );

    // --- 4. seaside_morning (7) ---
    case "sailboat":
      return (
        <g>
          <path
            d="M48 16 L48 64"
            stroke="#6B3E26"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <polygon
            points="50,18 78,56 50,56"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <polygon
            points="46,24 24,56 46,56"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <path
            d="M16 64 L84 64 L74 80 L26 80 Z"
            fill="#8D5524"
            stroke="#5C3317"
            strokeWidth={3}
            strokeLinejoin="round"
          />
        </g>
      );
    case "seashell":
      return (
        <g>
          <path
            d="M50 78 L18 52 C18 28 34 20 50 20 C66 20 82 28 82 52 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M50 76 L50 22 M50 76 L34 26 M50 76 L66 26"
            stroke={c.light}
            strokeWidth={2.8}
            strokeLinecap="round"
          />
          <rect
            x={36}
            y={72}
            width={28}
            height={9}
            rx={4}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
        </g>
      );
    case "starfish":
      return (
        <g>
          <polygon
            points="50,14 60,38 86,40 66,56 72,82 50,68 28,82 34,56 14,40 40,38"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
            strokeLinejoin="round"
          />
          <circle cx={44} cy={48} r={2.5} fill="#1E293B" />
          <circle cx={56} cy={48} r={2.5} fill="#1E293B" />
          <path
            d="M45 55 Q50 59 55 55"
            fill="none"
            stroke="#1E293B"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={50} cy={30} r={3} fill={c.light} />
          <circle cx={34} cy={46} r={2.5} fill={c.light} />
          <circle cx={66} cy={46} r={2.5} fill={c.light} />
        </g>
      );
    case "sandcastle":
      return (
        <g>
          <path d="M50 14 L50 30" stroke={c.stroke} strokeWidth={3} />
          <polygon
            points="50,14 66,20 50,26"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2}
          />
          <rect
            x={20}
            y={44}
            width={60}
            height={38}
            rx={4}
            fill="#F3C978"
            stroke="#9A6B22"
            strokeWidth={3}
          />
          <rect
            x={20}
            y={32}
            width={16}
            height={14}
            fill="#F3C978"
            stroke="#9A6B22"
            strokeWidth={3}
          />
          <rect
            x={42}
            y={28}
            width={16}
            height={18}
            fill="#F3C978"
            stroke="#9A6B22"
            strokeWidth={3}
          />
          <rect
            x={64}
            y={32}
            width={16}
            height={14}
            fill="#F3C978"
            stroke="#9A6B22"
            strokeWidth={3}
          />
          <path
            d="M40 82 L40 62 A10 10 0 0 1 60 62 L60 82 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
        </g>
      );
    case "seagull":
      return (
        <g>
          <path
            d="M12 44 Q32 24 50 46 Q68 24 88 44"
            fill="none"
            stroke="#FFFDF5"
            strokeWidth={11}
            strokeLinecap="round"
          />
          <path
            d="M12 44 Q32 24 50 46 Q68 24 88 44"
            fill="none"
            stroke={c.stroke}
            strokeWidth={3.2}
            strokeLinecap="round"
          />
          <ellipse
            cx={50}
            cy={54}
            rx={16}
            ry={10}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
          />
          <polygon
            points="64,52 76,56 64,60"
            fill="#F59E0B"
            stroke="#92400E"
            strokeWidth={2}
          />
          <circle cx={58} cy={52} r={2.3} fill="#1E293B" />
        </g>
      );
    case "swim_ring":
      return (
        <g>
          <circle
            cx={50}
            cy={50}
            r={30}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
          />
          <path
            d="M22 42 L78 42 M22 58 L78 58"
            stroke="#FFFDF5"
            strokeWidth={6}
            opacity={0.85}
          />
          <circle
            cx={50}
            cy={50}
            r={14}
            fill="#E0F7FF"
            stroke={c.stroke}
            strokeWidth={3}
          />
        </g>
      );
    case "beach_umbrella":
      return (
        <g>
          <path
            d="M50 44 L50 84"
            stroke="#92400E"
            strokeWidth={5}
            strokeLinecap="round"
          />
          <path
            d="M14 48 C18 20 82 20 86 48 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M35 48 C38 24 62 24 65 48 Z"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
        </g>
      );

    // --- 5. countryside_pond (7) ---
    case "lotus_flower":
      return (
        <g>
          <ellipse
            cx={50}
            cy={70}
            rx={36}
            ry={12}
            fill="#2DA462"
            stroke="#11522C"
            strokeWidth={3}
          />
          <ellipse
            cx={32}
            cy={52}
            rx={11}
            ry={20}
            transform="rotate(-32 32 52)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.5}
          />
          <ellipse
            cx={68}
            cy={52}
            rx={11}
            ry={20}
            transform="rotate(32 68 52)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.5}
          />
          <ellipse
            cx={41}
            cy={46}
            rx={11}
            ry={22}
            transform="rotate(-14 41 46)"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <ellipse
            cx={59}
            cy={46}
            rx={11}
            ry={22}
            transform="rotate(14 59 46)"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <ellipse
            cx={50}
            cy={44}
            rx={12}
            ry={24}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
          />
          <circle cx={50} cy={50} r={6} fill="#FFE074" />
        </g>
      );
    case "green_frog":
      return (
        <g>
          <ellipse
            cx={50}
            cy={74}
            rx={34}
            ry={10}
            fill="#34B36A"
            stroke="#11522C"
            strokeWidth={2.5}
          />
          <ellipse
            cx={50}
            cy={56}
            rx={24}
            ry={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={38}
            cy={34}
            r={9}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={62}
            cy={34}
            r={9}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle cx={38} cy={34} r={4.5} fill="#FFFDF5" />
          <circle cx={62} cy={34} r={4.5} fill="#FFFDF5" />
          <circle cx={38} cy={34} r={2.3} fill="#1E293B" />
          <circle cx={62} cy={34} r={2.3} fill="#1E293B" />
          <path
            d="M36 56 Q50 66 64 56"
            fill="none"
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <ellipse cx={50} cy={63} rx={13} ry={7} fill={c.light} />
        </g>
      );
    case "dragonfly":
      return (
        <g>
          <ellipse
            cx={30}
            cy={40}
            rx={20}
            ry={7}
            transform="rotate(-12 30 40)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <ellipse
            cx={70}
            cy={40}
            rx={20}
            ry={7}
            transform="rotate(12 70 40)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <ellipse
            cx={33}
            cy={54}
            rx={16}
            ry={6}
            transform="rotate(10 33 54)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <ellipse
            cx={67}
            cy={54}
            rx={16}
            ry={6}
            transform="rotate(-10 67 54)"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <rect
            x={46}
            y={28}
            width={8}
            height={54}
            rx={4}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <circle
            cx={50}
            cy={26}
            r={8}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <circle cx={46} cy={24} r={2.4} fill="#FFFDF5" />
          <circle cx={54} cy={24} r={2.4} fill="#FFFDF5" />
        </g>
      );
    case "yellow_duck":
      return (
        <g>
          <ellipse
            cx={46}
            cy={62}
            rx={26}
            ry={17}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle
            cx={64}
            cy={38}
            r={14}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <polygon
            points="75,36 89,40 75,45"
            fill="#F97316"
            stroke="#9A3412"
            strokeWidth={2.2}
            strokeLinejoin="round"
          />
          <circle cx={66} cy={35} r={2.8} fill="#1E293B" />
          <ellipse
            cx={44}
            cy={62}
            rx={13}
            ry={8}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.2}
          />
        </g>
      );
    case "carp_fish":
      return (
        <g>
          <polygon
            points="24,52 10,34 12,70"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <ellipse
            cx={54}
            cy={52}
            rx={28}
            ry={18}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <path
            d="M46 34 Q54 22 64 34"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <circle cx={70} cy={47} r={3.5} fill="#FFFDF5" />
          <circle cx={71} cy={47} r={1.8} fill="#1E293B" />
          <path
            d="M44 46 Q50 52 44 58 M54 44 Q60 52 54 60"
            fill="none"
            stroke={c.light}
            strokeWidth={2.6}
            strokeLinecap="round"
          />
        </g>
      );
    case "conical_hat":
      return (
        <g>
          <polygon
            points="50,18 86,68 14,68"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
            strokeLinejoin="round"
          />
          <path
            d="M36 42 L64 42 M26 56 L74 56"
            stroke={c.light}
            strokeWidth={2.8}
            strokeLinecap="round"
          />
          <path
            d="M34 68 Q50 86 66 68"
            fill="none"
            stroke="#D63031"
            strokeWidth={3.2}
            strokeLinecap="round"
          />
        </g>
      );
    case "bamboo_boat":
      return (
        <g>
          <path
            d="M12 52 Q50 84 88 52 L78 66 Q50 82 22 66 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <rect
            x={38}
            y={54}
            width={24}
            height={6}
            rx={2}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2}
          />
          <path
            d="M30 34 L68 72"
            stroke="#6B3E26"
            strokeWidth={4}
            strokeLinecap="round"
          />
        </g>
      );

    // --- 6. friendly_market (7) ---
    case "watermelon":
      return (
        <g>
          <circle
            cx={50}
            cy={52}
            r={29}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
          />
          <path
            d="M35 28 Q41 52 35 76 M50 23 Q54 52 50 81 M65 28 Q60 52 65 76"
            fill="none"
            stroke={c.light}
            strokeWidth={4}
            strokeLinecap="round"
          />
          <path
            d="M50 22 Q56 14 62 18"
            fill="none"
            stroke="#11522C"
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </g>
      );
    case "banana_bunch":
      return (
        <g>
          <path d="M46 18 L54 18 L52 30 L48 30 Z" fill="#6B3E26" />
          <path
            d="M46 28 C26 38 22 62 34 78 C36 62 40 46 50 34 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <path
            d="M50 28 C44 46 44 68 54 80 C58 64 58 46 54 32 Z"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <path
            d="M54 28 C72 38 78 62 66 78 C64 62 60 46 50 34 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
        </g>
      );
    case "woven_basket":
      return (
        <g>
          <path
            d="M26 44 C26 16 74 16 74 44"
            fill="none"
            stroke={c.stroke}
            strokeWidth={5.5}
            strokeLinecap="round"
          />
          <path
            d="M18 44 L82 44 L72 80 L28 80 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path
            d="M23 56 L77 56 M26 68 L74 68 M38 44 L40 80 M50 44 L50 80 M62 44 L60 80"
            stroke={c.light}
            strokeWidth={2.4}
          />
        </g>
      );
    case "clay_piggy":
      return (
        <g>
          <ellipse
            cx={50}
            cy={56}
            rx={28}
            ry={21}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <polygon
            points="34,39 30,24 44,34"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <polygon
            points="62,38 68,24 54,34"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
          <ellipse
            cx={76}
            cy={56}
            rx={8}
            ry={10}
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
          />
          <circle cx={74} cy={54} r={1.8} fill={c.stroke} />
          <circle cx={78} cy={54} r={1.8} fill={c.stroke} />
          <circle cx={62} cy={48} r={2.8} fill="#1E293B" />
          <rect x={44} y={39} width={12} height={4} rx={2} fill={c.stroke} />
          <rect
            x={33}
            y={73}
            width={8}
            height={10}
            rx={3}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
          <rect
            x={57}
            y={73}
            width={8}
            height={10}
            rx={3}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.4}
          />
        </g>
      );
    case "pinwheel":
      return (
        <g>
          <path
            d="M50 44 L50 88"
            stroke="#6B3E26"
            strokeWidth={5}
            strokeLinecap="round"
          />
          <polygon
            points="50,44 50,16 74,30"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <polygon
            points="50,44 78,44 64,68"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <polygon
            points="50,44 50,72 26,58"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <polygon
            points="50,44 22,44 36,20"
            fill={c.light}
            stroke={c.stroke}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <circle
            cx={50}
            cy={44}
            r={6}
            fill="#FFFDF5"
            stroke={c.stroke}
            strokeWidth={2.4}
          />
        </g>
      );
    case "banh_chung":
      return (
        <g>
          <rect
            x={20}
            y={24}
            width={60}
            height={56}
            rx={10}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3.2}
          />
          <path
            d="M40 24 L40 80 M60 24 L60 80 M20 44 L80 44 M20 62 L80 62"
            stroke="#FDE68A"
            strokeWidth={4.5}
          />
        </g>
      );
    case "mango_fruit":
      return (
        <g>
          <path
            d="M54 16 L54 26"
            stroke="#6B3E26"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <ellipse
            cx={64}
            cy={22}
            rx={10}
            ry={4.5}
            transform="rotate(-18 64 22)"
            fill="#1F8A4C"
            stroke="#11522C"
            strokeWidth={2}
          />
          <path
            d="M52 24 C74 26 80 54 64 76 C52 88 32 82 28 66 C24 46 36 23 52 24 Z"
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <ellipse
            cx={42}
            cy={46}
            rx={6}
            ry={13}
            transform="rotate(-14 42 46)"
            fill={c.light}
            opacity={0.7}
          />
        </g>
      );

    default:
      return (
        <g>
          <circle
            cx={50}
            cy={50}
            r={28}
            fill={c.fill}
            stroke={c.stroke}
            strokeWidth={3}
          />
          <circle cx={50} cy={50} r={12} fill={c.light} />
        </g>
      );
  }
}

function renderThemeBackdrop(
  themeKey: MemoryThemeKey,
  sceneSpec: SceneSpecDTO,
  gradId: string,
): ReactElement {
  const { backdrop, canvas_width: w, canvas_height: h } = sceneSpec;
  const horizonY = Math.round(h * 0.56);

  return (
    <g aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={backdrop.sky_top_hex} />
          <stop offset="100%" stopColor={backdrop.sky_bottom_hex} />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={w} height={h} fill={`url(#${gradId})`} />

      {themeKey === "sunny_garden" ? (
        <g>
          <circle cx={720} cy={66} r={34} fill="#FFE074" opacity={0.95} />
          <ellipse
            cx={160}
            cy={62}
            rx={48}
            ry={18}
            fill="#FFFFFF"
            opacity={0.8}
          />
          <ellipse
            cx={455}
            cy={54}
            rx={54}
            ry={16}
            fill="#FFFFFF"
            opacity={0.75}
          />
          <path
            d={`M0 ${horizonY + 12} Q220 ${horizonY - 46} 460 ${horizonY + 4} T${w} ${horizonY - 12} L${w} ${h} L0 ${h} Z`}
            fill={backdrop.horizon_hex}
          />
          <rect
            x={0}
            y={horizonY + 44}
            width={w}
            height={h - horizonY}
            fill={backdrop.ground_hex}
            opacity={0.45}
          />
          {[60, 140, 220, 300, 380, 460, 540, 620, 700].map((fx) => (
            <rect
              key={fx}
              x={fx}
              y={horizonY - 8}
              width={12}
              height={42}
              rx={4}
              fill="#FFFDF5"
              opacity={0.55}
            />
          ))}
        </g>
      ) : null}

      {themeKey === "happy_classroom" ? (
        <g>
          <rect
            x={210}
            y={40}
            width={380}
            height={175}
            rx={12}
            fill="#1E6B52"
            stroke="#9C6644"
            strokeWidth={10}
          />
          <rect
            x={36}
            y={48}
            width={118}
            height={130}
            rx={8}
            fill="#D8F3FF"
            stroke="#C59B6D"
            strokeWidth={6}
          />
          <path
            d="M95 48 L95 178 M36 113 L154 113"
            stroke="#C59B6D"
            strokeWidth={4}
          />
          <rect
            x={0}
            y={horizonY + 28}
            width={w}
            height={h - horizonY}
            fill={backdrop.ground_hex}
          />
          <path
            d={`M0 ${horizonY + 28} L${w} ${horizonY + 28}`}
            stroke="#B08968"
            strokeWidth={4}
          />
        </g>
      ) : null}

      {themeKey === "mid_autumn_yard" ? (
        <g>
          <circle cx={690} cy={78} r={44} fill="#FFF2A6" />
          <circle cx={690} cy={78} r={58} fill="#FFE074" opacity={0.22} />
          {[
            [90, 50],
            [210, 38],
            [340, 58],
            [490, 36],
            [585, 62],
          ].map(([sx, sy], idx) => (
            <circle
              key={idx}
              cx={sx}
              cy={sy}
              r={3.5}
              fill="#FFF7D6"
              opacity={0.9}
            />
          ))}
          <path
            d={`M0 24 Q200 72 400 28 T${w} 30`}
            fill="none"
            stroke="#FFCA3A"
            strokeWidth={3}
            opacity={0.7}
          />
          <rect
            x={0}
            y={horizonY + 24}
            width={w}
            height={h - horizonY}
            fill={backdrop.ground_hex}
          />
          <path
            d={`M0 ${horizonY + 24} L${w} ${horizonY + 24} M0 ${horizonY + 94} L${w} ${horizonY + 94}`}
            stroke="#B55B3C"
            strokeWidth={3}
            opacity={0.45}
          />
        </g>
      ) : null}

      {themeKey === "seaside_morning" ? (
        <g>
          <circle cx={126} cy={92} r={38} fill="#FFE074" opacity={0.92} />
          <rect
            x={0}
            y={horizonY - 46}
            width={w}
            height={116}
            fill={backdrop.horizon_hex}
          />
          <path
            d={`M0 ${horizonY + 4} Q100 ${horizonY - 12} 200 ${horizonY + 4} T400 ${horizonY + 4} T600 ${horizonY + 4} T800 ${horizonY + 4}`}
            fill="none"
            stroke="#BEE9FF"
            strokeWidth={4}
            opacity={0.75}
          />
          <path
            d={`M0 ${horizonY + 52} Q240 ${horizonY + 34} 520 ${horizonY + 54} T${w} ${horizonY + 44} L${w} ${h} L0 ${h} Z`}
            fill={backdrop.ground_hex}
          />
        </g>
      ) : null}

      {themeKey === "countryside_pond" ? (
        <g>
          <ellipse
            cx={640}
            cy={60}
            rx={52}
            ry={17}
            fill="#FFFFFF"
            opacity={0.85}
          />
          <ellipse
            cx={180}
            cy={70}
            rx={44}
            ry={15}
            fill="#FFFFFF"
            opacity={0.75}
          />
          <path
            d={`M0 ${horizonY - 22} Q260 ${horizonY - 62} 540 ${horizonY - 18} T${w} ${horizonY - 28} L${w} ${h} L0 ${h} Z`}
            fill={backdrop.ground_hex}
          />
          <ellipse
            cx={400}
            cy={340}
            rx={360}
            ry={124}
            fill={backdrop.horizon_hex}
            opacity={0.9}
          />
          <ellipse
            cx={220}
            cy={325}
            rx={34}
            ry={12}
            fill="#2DA462"
            opacity={0.55}
          />
          <ellipse
            cx={580}
            cy={360}
            rx={40}
            ry={14}
            fill="#2DA462"
            opacity={0.55}
          />
        </g>
      ) : null}

      {themeKey === "friendly_market" ? (
        <g>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((idx) => (
            <rect
              key={idx}
              x={idx * 100}
              y={0}
              width={100}
              height={46}
              fill={idx % 2 === 0 ? "#D96B43" : "#FFFDF5"}
              opacity={0.88}
            />
          ))}
          <rect
            x={0}
            y={horizonY + 36}
            width={w}
            height={h - horizonY}
            fill={backdrop.ground_hex}
          />
          <rect
            x={48}
            y={horizonY + 12}
            width={w - 96}
            height={28}
            rx={8}
            fill="#C68B59"
            opacity={0.5}
          />
        </g>
      ) : null}
    </g>
  );
}

function getSubOffsets(
  count: number,
): readonly { dx: number; dy: number; scale: number }[] {
  if (count <= 1) return [{ dx: 0.5, dy: 0.5, scale: 0.92 }];
  if (count === 2) {
    return [
      { dx: 0.29, dy: 0.52, scale: 0.62 },
      { dx: 0.71, dy: 0.52, scale: 0.62 },
    ];
  }
  return [
    { dx: 0.24, dy: 0.58, scale: 0.52 },
    { dx: 0.5, dy: 0.36, scale: 0.52 },
    { dx: 0.76, dy: 0.58, scale: 0.52 },
  ];
}

export function MemorySceneCanvas({
  sceneSpec,
  mode,
  showColorCues = true,
  reducedMotion = false,
  matchedObjectIds,
  missedObjectIds,
  focusedObjectId = null,
  onSelectObject,
  onSceneReady,
  className = "",
}: MemorySceneCanvasProps) {
  const t = useTranslations("games");
  const uniqueId = useId().replace(/:/g, "");
  const gradId = `mem-sky-${uniqueId}`;
  const maskId = `mem-spotlight-mask-${uniqueId}`;

  const width = sceneSpec.canvas_width || 800;
  const height = sceneSpec.canvas_height || 500;

  useEffect(() => {
    if (!onSceneReady) return;
    // Trigger strictly after SVG DOM commits and paints a frame
    let cancelled = false;
    const raf =
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame(() => {
            if (!cancelled) onSceneReady(sceneSpec.scene_seed);
          })
        : null;

    if (raf === null) {
      onSceneReady(sceneSpec.scene_seed);
    }

    return () => {
      cancelled = true;
      if (raf !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [onSceneReady, sceneSpec.scene_seed]);

  const focusedObject: SceneObjectSpecDTO | null =
    mode === "reveal" && focusedObjectId
      ? (sceneSpec.objects.find((o) => o.id === focusedObjectId) ?? null)
      : null;

  return (
    <div
      className={`relative overflow-hidden rounded-card border-2 border-border bg-white shadow-sm ${reducedMotion ? "motion-reduce" : ""} ${className}`}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="memory-scene-container"
    >
      <svg
        aria-label={t("memoryGame.canvas.svgAria", {
          theme: sceneSpec.theme_name_vi,
          count: sceneSpec.objects.length,
        })}
        className="block h-auto w-full select-none"
        data-scene-ready="true"
        data-scene-seed={String(sceneSpec.scene_seed)}
        data-testid="memory-scene-svg"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>
          {t("memoryGame.canvas.svgTitle", {
            theme: sceneSpec.theme_name_vi,
          })}
        </title>
        <desc>{sceneSpec.backdrop.mood_vi}</desc>

        {renderThemeBackdrop(sceneSpec.theme_key, sceneSpec, gradId)}

        {/* Deterministic collision-free objects */}
        {sceneSpec.objects.map((obj) => {
          const boxX = obj.bbox.x * width;
          const boxY = obj.bbox.y * height;
          const boxW = obj.bbox.w * width;
          const boxH = obj.bbox.h * height;
          const offsets = getSubOffsets(obj.count);
          const unitSize = Math.min(boxW, boxH);
          const colors: SpriteColors = {
            fill: obj.color_hex,
            stroke: obj.color_stroke_hex,
            light: obj.color_light_hex,
          };

          const isMatched =
            mode === "reveal" && Boolean(matchedObjectIds?.has(obj.id));
          const isMissed =
            mode === "reveal" && Boolean(missedObjectIds?.has(obj.id));
          const isFocused = mode === "reveal" && focusedObjectId === obj.id;
          const spotlightState = isFocused
            ? "focused"
            : isMatched
              ? "matched"
              : isMissed
                ? "missed"
                : "none";

          return (
            <g
              key={obj.id}
              className={
                mode === "reveal" && onSelectObject
                  ? "cursor-pointer"
                  : undefined
              }
              data-object-id={obj.id}
              data-spotlight-state={spotlightState}
              data-sprite-key={obj.sprite_key}
              onClick={
                mode === "reveal" && onSelectObject
                  ? () => onSelectObject(obj.id)
                  : undefined
              }
            >
              {/* Soft ground shadow pill inside object bounding box */}
              <ellipse
                cx={boxX + boxW / 2}
                cy={boxY + boxH * 0.86}
                rx={boxW * 0.34}
                ry={boxH * 0.08}
                fill="#1E293B"
                opacity={0.12}
              />

              {/* Render 1..3 vector sprites inside this exact bounding box */}
              {offsets.map((offset, idx) => {
                const spriteSize = unitSize * offset.scale;
                const tx = boxX + boxW * offset.dx - spriteSize / 2;
                const ty = boxY + boxH * offset.dy - spriteSize / 2;
                const scaleFactor = spriteSize / 100;
                return (
                  <g
                    key={idx}
                    transform={`translate(${tx.toFixed(1)}, ${ty.toFixed(1)}) scale(${scaleFactor.toFixed(3)})`}
                  >
                    {renderSpriteArtwork(obj.sprite_key, colors)}
                  </g>
                );
              })}

              {/* Accessible colorblind shape cue in corner */}
              {showColorCues ? (
                <g
                  aria-hidden="true"
                  transform={`translate(${(boxX + boxW - 12).toFixed(1)}, ${(boxY + 12).toFixed(1)})`}
                >
                  {renderShapeCue(obj.shape_cue, colors)}
                </g>
              ) : null}

              {/* Reveal & Spotlight bounding box rings */}
              {mode === "reveal" && (isMatched || isMissed || isFocused) ? (
                <g>
                  <rect
                    x={boxX - 4}
                    y={boxY - 4}
                    width={boxW + 8}
                    height={boxH + 8}
                    rx={14}
                    fill={
                      isMatched
                        ? "rgba(31, 138, 76, 0.10)"
                        : "rgba(224, 159, 0, 0.14)"
                    }
                    stroke={isMatched ? "#1F8A4C" : "#D97706"}
                    strokeDasharray={isMatched ? undefined : "8 5"}
                    strokeWidth={isFocused ? 5 : 3.5}
                  />
                  {/* Badge pill */}
                  <rect
                    x={boxX}
                    y={Math.max(4, boxY - 22)}
                    width={Math.min(boxW + 24, 180)}
                    height={22}
                    rx={11}
                    fill={isMatched ? "#1F8A4C" : "#B45309"}
                  />
                  <text
                    x={boxX + 10}
                    y={Math.max(19, boxY - 7)}
                    fill="#FFFFFF"
                    fontSize={12}
                    fontWeight={700}
                  >
                    {`${isMatched ? "✓ " : "★ "}${obj.count > 1 ? `${obj.count} ` : ""}${obj.name_vi}`}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}

        {/* Focused Spotlight Scrim — dims surrounding scene to illuminate exact [x,y,w,h] */}
        {focusedObject ? (
          <g pointerEvents="none" data-testid="memory-spotlight-focus">
            <defs>
              <mask id={maskId}>
                <rect
                  x={0}
                  y={0}
                  width={width}
                  height={height}
                  fill="#FFFFFF"
                />
                <rect
                  x={focusedObject.bbox.x * width - 8}
                  y={focusedObject.bbox.y * height - 8}
                  width={focusedObject.bbox.w * width + 16}
                  height={focusedObject.bbox.h * height + 16}
                  rx={18}
                  fill="#000000"
                />
              </mask>
            </defs>
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              fill="rgba(17, 24, 39, 0.42)"
              mask={`url(#${maskId})`}
            />
            <rect
              x={focusedObject.bbox.x * width - 8}
              y={focusedObject.bbox.y * height - 8}
              width={focusedObject.bbox.w * width + 16}
              height={focusedObject.bbox.h * height + 16}
              rx={18}
              fill="none"
              stroke="#FFE074"
              strokeWidth={5}
            />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
