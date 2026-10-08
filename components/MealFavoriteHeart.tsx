"use client";

import { Heart } from "lucide-react";
import dark from "./AfterDarkCards.module.css";

/** What the page knows about this plate as a favorite meal (a saved meal, never a food mark). */
export type MealFavorite = { on: boolean; pending?: boolean; onToggle: () => void };

/**
 * Meal cards v3: the heart on the photo's upper right. Outline until the plate is saved as a favorite
 * meal, filled once it is; a favorite only boosts and never gates a plan. The name says the action,
 * and while the write runs the heart takes no second tap. Undo is the page's (ActionFeedback).
 */
export default function MealFavoriteHeart({ label, favorite }: {
  /** The dish's name: the heart saves this plate, so it is named by what is on it. */
  label: string; favorite: MealFavorite;
}) {
  return <button type="button" aria-disabled={favorite.pending || undefined} aria-busy={favorite.pending || undefined}
    data-meal-favorite={favorite.on ? "on" : "off"}
    aria-label={favorite.on ? `Remove ${label} from favorite meals` : `Save ${label} as a favorite meal`}
    onClick={(event) => { event.stopPropagation(); if (!favorite.pending) favorite.onToggle(); }} className={dark.heart}>
    <Heart aria-hidden="true" size={18} strokeWidth={2} fill={favorite.on ? "currentColor" : "none"} />
  </button>;
}
