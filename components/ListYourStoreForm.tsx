"use client";

import { useState } from "react";

/**
 * Merchant listing-request form.
 *
 * The app has no backend storage and no mail-sending service, so this
 * form does NOT submit anything by itself. It composes a prefilled
 * email (subject + every field in the body) addressed to Nio
 * Innovations and hands it to the visitor's own email app via a
 * mailto: link. The request exists only once the visitor sends that
 * email — the confirmation copy on this page says exactly that.
 */
const LISTING_EMAIL = "barath@nioinnovations.com";

type Fields = {
  storeName: string;
  websiteUrl: string;
  contactName: string;
  contactEmail: string;
  sells: string;
  ucpUrl: string;
  notes: string;
};

const EMPTY: Fields = {
  storeName: "",
  websiteUrl: "",
  contactName: "",
  contactEmail: "",
  sells: "",
  ucpUrl: "",
  notes: "",
};

function buildMailto(f: Fields): string {
  const subject = `Store listing request — ${f.storeName.trim()}`;
  const lines = [
    `Store name: ${f.storeName.trim()}`,
    `Website: ${f.websiteUrl.trim()}`,
    `Contact name: ${f.contactName.trim()}`,
    `Contact email: ${f.contactEmail.trim()}`,
    `What the store sells: ${f.sells.trim()}`,
  ];
  if (f.ucpUrl.trim()) lines.push(`UCP profile URL: ${f.ucpUrl.trim()}`);
  if (f.notes.trim()) lines.push("", `Notes: ${f.notes.trim()}`);
  lines.push(
    "",
    "Sent from the “List your store” page on Not Delivered in the Blue Truck."
  );
  return `mailto:${LISTING_EMAIL}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(lines.join("\n"))}`;
}

export default function ListYourStoreForm() {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [mailtoHref, setMailtoHref] = useState<string | null>(null);

  const set =
    (key: keyof Fields) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >
    ) =>
      setFields((prev) => ({ ...prev, [key]: e.target.value }));

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const href = buildMailto(fields);
    setMailtoHref(href);
    window.location.href = href;
  }

  if (mailtoHref) {
    return (
      <div className="requestSent">
        <h2>One more step — hit send in your email app</h2>
        <p>
          Your email app will open with the request addressed to us — send it
          and we&apos;ll take it from there. We read your store&apos;s terms,
          check the route in, and reply to your contact email either way.
        </p>
        <p>
          Nothing opened?{" "}
          <a className="textLink" href={mailtoHref}>
            Click here to open the prefilled request
          </a>
          , or write to us directly at {LISTING_EMAIL} with your store name,
          website, and what you sell.
        </p>
        <button
          type="button"
          className="btnOutline"
          onClick={() => setMailtoHref(null)}
        >
          Back to the form
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="formGrid">
        <label className="field">
          <span>Store name *</span>
          <input
            type="text"
            required
            value={fields.storeName}
            onChange={set("storeName")}
            placeholder="e.g. Acme Outdoor Supply"
            autoComplete="organization"
          />
        </label>
        <label className="field">
          <span>Website *</span>
          <input
            type="url"
            required
            value={fields.websiteUrl}
            onChange={set("websiteUrl")}
            placeholder="https://yourstore.com"
            autoComplete="url"
          />
        </label>
        <label className="field">
          <span>Contact name *</span>
          <input
            type="text"
            required
            value={fields.contactName}
            onChange={set("contactName")}
            autoComplete="name"
          />
        </label>
        <label className="field">
          <span>Contact email *</span>
          <input
            type="email"
            required
            value={fields.contactEmail}
            onChange={set("contactEmail")}
            autoComplete="email"
          />
        </label>
        <label className="field formWide">
          <span>What the store sells *</span>
          <input
            type="text"
            required
            value={fields.sells}
            onChange={set("sells")}
            placeholder="e.g. Hiking boots, tents, and outdoor gear"
          />
        </label>
        <label className="field formWide">
          <span>Your store&apos;s UCP profile URL (if you have one)</span>
          <input
            type="url"
            value={fields.ucpUrl}
            onChange={set("ucpUrl")}
            placeholder="https://yourstore.com/.well-known/ucp"
          />
          <small className="fieldHint">
            A published UCP profile is the fastest route in. No profile? Leave
            this blank — we&apos;ll check the other routes.
          </small>
        </label>
        <label className="field formWide">
          <span>Notes (optional)</span>
          <textarea
            value={fields.notes}
            onChange={set("notes")}
            rows={4}
            placeholder="Anything we should know — catalog size, an API you offer, a person to talk to."
          />
        </label>
      </div>
      <button type="submit" className="btnCoral">
        Prepare my request
      </button>
      <p className="fieldHint">
        This form doesn&apos;t send anything by itself. It opens your email
        app with the request already written and addressed to us — you review
        it and press send.
      </p>
    </form>
  );
}
