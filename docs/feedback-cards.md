# Feedback: summary cards as filters (2026-11-24)

A card and the Status box are one value, so they cannot disagree. Priority, category, assignee, source and search work on top of it and on the card numbers: a card's number is always the length of
the list its click opens. Pressing the active card again, **Total feedback** or **Show all feedback** shows everything (the last one also clears the other filters and the search). The page opens on
the open issues, as before. A new filter starts on page 1; the 30-second refresh keeps the page and the filter. Rules: `src/lib/feedbackFilters.ts`, tests `tests/unit/feedbackFilters.test.ts` and
`tests/shop-e2e/feedback-cards.spec.ts`. The list is loaded once (at most 1,000 issues) and filtered in the browser, as before.

Pictures attached to feedback are private (the reporter and staff). They were never on a customer page and still are not.
