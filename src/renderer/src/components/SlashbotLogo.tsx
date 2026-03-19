import React from 'react'

interface SlashbotLogoProps {
  size?: number
  className?: string
}

/**
 * Slashbot logo — hexagon with forward-slash motif and bot eyes.
 */
export default function SlashbotLogo({ size = 64, className }: SlashbotLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Hexagon outline */}
      <path
        d="M50 4L93.3 27v46L50 96 6.7 73V27L50 4z"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        opacity="0.85"
      />

      {/* Inner glow hexagon */}
      <path
        d="M50 12L87 31.5v39L50 90 13 70.5v-39L50 12z"
        fill="currentColor"
        opacity="0.06"
      />

      {/* Forward slash — the signature mark */}
      <line
        x1="60"
        y1="28"
        x2="40"
        y2="72"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.9"
      />

      {/* Bot eyes */}
      <circle cx="34" cy="44" r="4.5" fill="currentColor" opacity="0.8" />
      <circle cx="66" cy="44" r="4.5" fill="currentColor" opacity="0.8" />

      {/* Eye glints */}
      <circle cx="35.5" cy="42.5" r="1.5" fill="currentColor" opacity="0.3" />
      <circle cx="67.5" cy="42.5" r="1.5" fill="currentColor" opacity="0.3" />
    </svg>
  )
}
