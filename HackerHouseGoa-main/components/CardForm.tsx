"use client";

import { useId } from "react";

import { formatBuilderNumber, maskPhone, sanitizePhone } from "@/lib/titles";
import type { CardFields } from "@/lib/types";

export interface CardFormProps {
  fields: CardFields;
  onChange: (next: CardFields) => void;
  onReroll: () => void;
}

const LABEL = "block font-data text-[11px] uppercase tracking-[0.18em] text-goa-ink/65";
const INPUT =
  "mt-1 w-full rounded-sm border-2 border-goa-ink/25 bg-white px-3 py-2 text-base text-goa-ink placeholder:text-goa-ink/35 focus:border-goa-red";

export default function CardForm({ fields, onChange, onReroll }: CardFormProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const roleId = `${uid}-role`;
  const collegeId = `${uid}-college`;
  const phoneId = `${uid}-phone`;
  const phoneHintId = `${uid}-phone-hint`;

  return (
    <section className="mt-4 rounded-md border-[3px] border-goa-cream bg-goa-cream p-4 text-goa-ink shadow-[5px_5px_0_0_var(--color-goa-green-deep)]">
      <p className="font-data text-[10px] uppercase tracking-[0.24em] text-goa-red">Your details</p>

      <div className="mt-3">
        <label htmlFor={nameId} className={LABEL}>
          Name <span className="text-goa-red">*</span>
        </label>
        <input
          id={nameId}
          type="text"
          value={fields.name}
          maxLength={28}
          autoCapitalize="words"
          autoComplete="name"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Ada Lovelace"
          className={`${INPUT} font-display text-lg`}
          onChange={(event) => onChange({ ...fields, name: event.target.value })}
        />
      </div>

      <div className="mt-3">
        <label htmlFor={roleId} className={LABEL}>
          Role in the team
        </label>
        <input
          id={roleId}
          type="text"
          value={fields.role}
          maxLength={32}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          placeholder="DevOps Engineer"
          className={`${INPUT} font-data`}
          onChange={(event) => onChange({ ...fields, role: event.target.value })}
        />
      </div>

      <div className="mt-3">
        <label htmlFor={collegeId} className={LABEL}>
          College
        </label>
        <input
          id={collegeId}
          type="text"
          value={fields.college}
          maxLength={34}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          placeholder="WCE Sangli"
          className={`${INPUT} font-data`}
          onChange={(event) => onChange({ ...fields, college: event.target.value })}
        />
      </div>

      <div className="mt-3">
        <label htmlFor={phoneId} className={LABEL}>
          Phone
        </label>
        <input
          id={phoneId}
          type="tel"
          // inputMode + pattern together are what actually summon the numeric
          // keypad across iOS and Android; type="tel" alone is unreliable.
          inputMode="numeric"
          pattern="[0-9]*"
          value={fields.phone}
          maxLength={15}
          autoComplete="tel"
          autoCorrect="off"
          spellCheck={false}
          placeholder="9876543210"
          aria-describedby={phoneHintId}
          className={`${INPUT} font-data tracking-[0.08em]`}
          onChange={(event) => onChange({ ...fields, phone: sanitizePhone(event.target.value) })}
        />
        <p id={phoneHintId} className="mt-1 font-data text-[11px] leading-snug text-goa-ink/60">
          {fields.phone.length > 0 ? (
            <>
              Your card will show{" "}
              <span className="font-semibold tracking-[0.12em] text-goa-ink">
                {maskPhone(fields.phone)}
              </span>{" "}
              — never the full number.
            </>
          ) : (
            <>Only the last 2 digits are printed on the card, so it&rsquo;s safe to post.</>
          )}
        </p>
      </div>

      <div className="mt-4 flex items-stretch gap-2">
        <div className="stamp min-w-0 flex-1 rounded-sm border-[3px] border-dashed border-goa-red bg-goa-cream px-3 py-2">
          <p className="font-data text-[9px] uppercase tracking-[0.22em] text-goa-red">Builder title</p>
          <p className="font-display text-lg leading-tight break-words text-goa-ink">{fields.title}</p>
        </div>
        <button
          type="button"
          onClick={onReroll}
          aria-label="Reroll builder title"
          title="Reroll builder title"
          className="h-11 w-11 shrink-0 self-center rounded-sm border-[3px] border-goa-ink bg-goa-yellow text-xl leading-none shadow-[3px_3px_0_0_var(--color-goa-ink)] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
        >
          <span aria-hidden="true">🎲</span>
        </button>
      </div>

      <p className="mt-4 border-t-2 border-dashed border-goa-ink/20 pt-3 font-data text-xs uppercase tracking-[0.2em] text-goa-ink/70">
        {formatBuilderNumber(fields.builderNo)}
      </p>
    </section>
  );
}
