import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPage } from "../../../playwright/browser";

const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;

// TOTO ZISTI CI NIE JE SELEKTOR FALOSNY
function isSyntheticSelector(selector: string) {
  const value = String(selector ?? "").trim().toLowerCase();
  return (
    value.startsWith("text=") ||
    value.startsWith("xpath=") ||
    value.startsWith("//") ||
    value.startsWith("role=") ||
    value.startsWith("getbyrole(") ||
    value.includes(">>") ||
    value.includes(":contains(") ||
    value.includes(":has-text(") ||
    value.includes("nth=")
  );
}

function normalizeComparable(value: string) {
  return String(value ?? "").trim().toLowerCase().normalize("NFD").replace(COMBINING_MARKS_REGEX, "");
}

function matchesExpectedValue(actual: string, expected: string, allowSubstringMatch = false) {
  if (actual === expected) return true;

  const actualNorm = normalizeComparable(actual);
  const expectedNorm = normalizeComparable(expected);

  if (actualNorm === expectedNorm) return true;
  if (allowSubstringMatch && expectedNorm && actualNorm.includes(expectedNorm)) return true;
  return false;
}

// TOTO PISE TEXT DO INPUTU ALEBO VYBERA HODNOTU V SELECT
export const typeTool = createTool({
  id: "browser_type",
  description: "Enter text into an input/textarea or select a value in a native select and verify it worked.",
  inputSchema: z.object({
    selector: z.string(),
    text: z.string(),
    clear: z.boolean().optional().default(true),
    allowSubstringMatch: z.boolean().optional().default(false),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ context }) => {
    const page = await getPage();
    const { selector, text, clear, allowSubstringMatch } = context;
    if (isSyntheticSelector(selector)) {
      throw new Error(`typeTool rejected synthetic selector "${selector}".`);
    }

    const pickTarget = async (matches: any) => {
      const count = await matches.count().catch(() => 0);
      if (count <= 1) {
        return {
          locator: matches.first(),
          count,
          visibleMatches: count === 1 ? 1 : 0,
        };
      }

      let firstVisibleIndex = -1;
      let visibleMatches = 0;

      for (let i = 0; i < count; i++) {
        const candidate = matches.nth(i);
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        const box = await candidate.boundingBox().catch(() => null);

        if (visible) visibleMatches++;
        if (firstVisibleIndex === -1 && visible && enabled && box) {
          firstVisibleIndex = i;
        }
      }

      if (firstVisibleIndex >= 0) {
        return {
          locator: matches.nth(firstVisibleIndex),
          count,
          visibleMatches,
        };
      }

      return {
        locator: matches.first(),
        count,
        visibleMatches,
      };
    };

    const loc = (await pickTarget(page.locator(selector))).locator;
    await loc.waitFor({ state: "attached", timeout: 6000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});

    const expected = String(text);
    const expectedTrim = expected.trim();
    const editableSelector =
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]';

    const isEditableLocator = async (candidate: any) => {
      try {
        return await candidate.evaluate((el: any) => {
          const tag = String(el?.tagName ?? "").toLowerCase();
          const role = String(el?.getAttribute?.("role") ?? "").toLowerCase();
          return (
            tag === "input" ||
            tag === "textarea" ||
            tag === "select" ||
            Boolean(el?.isContentEditable) ||
            role === "textbox" ||
            role === "searchbox" ||
            role === "combobox"
          );
        });
      } catch {
        return false;
      }
    };

    const resolveTypingTarget = async () => {
      if (await isEditableLocator(loc)) {
        return loc;
      }

      const descendants = await pickTarget(loc.locator(editableSelector));
      return descendants.count > 0 ? descendants.locator : loc;
    };

    const target = await resolveTypingTarget();

    const tagName = await target
      .evaluate((el: any) => String(el?.tagName ?? "").toLowerCase())
      .catch(() => "");
    const inputType = String((await target.getAttribute("type").catch(() => "")) ?? "").toLowerCase();
    const isPassword =
      inputType === "password" ||
      String(selector).toLowerCase().includes("password") ||
      String(selector).toLowerCase().includes("pass");

    const maskIfNeeded = (v: string) => (isPassword ? "***" : v);

    const readLocatorState = async (candidate: any) => {
      try {
        const direct = await candidate.inputValue();
        if (direct != null) return String(direct);
      } catch {}

      try {
        return (await candidate.evaluate((el: any) => {
          const read = (node: any) => {
            if (!node) return "";
            if (typeof node.value === "string" && node.value) return node.value;
            if (typeof node.innerText === "string" && node.innerText.trim()) return node.innerText;
            if (typeof node.textContent === "string" && node.textContent.trim()) return node.textContent;
            if (typeof node.getAttribute === "function") {
              const ariaValueText = node.getAttribute("aria-valuetext");
              if (ariaValueText) return ariaValueText;
            }
            return "";
          };

          const selfValue = read(el);
          if (selfValue) return selfValue;

          const nested = el?.querySelector?.(
            'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]'
          );
          return read(nested);
        })) as string;
      } catch {
        return "";
      }
    };

    const readCandidateValues = async () => {
      const values: string[] = [];
      const pushValue = (value: unknown) => {
        const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
        if (!normalized || values.includes(normalized)) return;
        values.push(normalized);
      };

      pushValue(await readLocatorState(target));
      if (target !== loc) {
        pushValue(await readLocatorState(loc));
      }

      try {
        const nestedValues = await loc.locator(editableSelector).evaluateAll((nodes: any[]) => {
          const read = (node: any) => {
            if (!node) return "";
            if (typeof node.value === "string" && node.value) return node.value;
            if (typeof node.innerText === "string" && node.innerText.trim()) return node.innerText;
            if (typeof node.textContent === "string" && node.textContent.trim()) return node.textContent;
            if (typeof node.getAttribute === "function") {
              const ariaValueText = node.getAttribute("aria-valuetext");
              if (ariaValueText) return ariaValueText;
            }
            return "";
          };

          return nodes.map(read).filter(Boolean).slice(0, 6);
        });
        for (const value of nestedValues) pushValue(value);
      } catch {}

      try {
        const activeValue = await page.evaluate(() => {
          const el: any = document.activeElement;
          if (!el) return "";
          if (typeof el.value === "string" && el.value) return el.value;
          if (typeof el.innerText === "string" && el.innerText.trim()) return el.innerText;
          if (typeof el.textContent === "string" && el.textContent.trim()) return el.textContent;
          if (typeof el.getAttribute === "function") {
            const ariaValueText = el.getAttribute("aria-valuetext");
            if (ariaValueText) return ariaValueText;
          }
          return "";
        });
        pushValue(activeValue);
      } catch {}

      return values;
    };

    const readBestValue = async () => {
      const values = await readCandidateValues();
      return {
        values,
        best: values[0] ?? "",
      };
    };

    const valueMatches = (actual: string) =>
      matchesExpectedValue(actual, expected, allowSubstringMatch) ||
      matchesExpectedValue(actual.trim(), expectedTrim, allowSubstringMatch);

    const hasExpectedValue = async () => {
      const state = await readBestValue();
      return {
        matches: state.values.some((value) => valueMatches(value)),
        lastValue: state.best,
      };
    };

    const readSelectState = async () => {
      return await target.evaluate((el: any) => {
        const selectedIndex = typeof el?.selectedIndex === "number" ? el.selectedIndex : -1;
        const selectedOption = selectedIndex >= 0 ? el.options?.[selectedIndex] : null;
        const value = el?.value != null ? String(el.value) : "";
        const label = selectedOption
          ? String(selectedOption.label ?? selectedOption.textContent ?? "").trim()
          : "";
        const options = Array.from(el?.options ?? [])
          .map((opt: any) => String(opt.label ?? opt.textContent ?? "").trim())
          .filter(Boolean)
          .slice(0, 20);

        return { value, label, options };
      });
    };

    const selectMatchesExpected = (state: { value: string; label: string }) =>
      matchesExpectedValue(state.value, expectedTrim, allowSubstringMatch) ||
      matchesExpectedValue(state.label, expectedTrim, allowSubstringMatch);

    if (tagName === "select") {
      let currentState = await readSelectState();
      if (selectMatchesExpected(currentState)) {
        return { ok: true };
      }

      const matchedOptionValue = await target.evaluate(
        (el: any, rawExpected: string) => {
          const norm = (value: any) =>
            String(value ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

          const wanted = norm(rawExpected);
          if (!wanted) return null;
          const options = Array.from(el?.options ?? []);
          const exact = options.find((opt: any) => {
            const label = norm(opt.label ?? opt.textContent ?? "");
            const value = norm(opt.value ?? "");
            return label === wanted || value === wanted;
          });

          const fuzzy =
            exact ??
            options.find((opt: any) => {
              const label = norm(opt.label ?? opt.textContent ?? "");
              const value = norm(opt.value ?? "");
              return (
                (label && wanted.includes(label)) ||
                (value && wanted.includes(value)) ||
                label.includes(wanted) ||
                value.includes(wanted)
              );
            });

          return fuzzy ? String((fuzzy as any).value ?? "") : null;
        },
        expectedTrim
      );

      if (matchedOptionValue == null) {
        throw new Error(
          `typeTool could not match select option for selector "${selector}". ` +
            `Expected "${expectedTrim}". Available options: ${currentState.options.join(", ")}`
        );
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await target.click({ timeout: 2500 }).catch(() => {});
        }

        await target.selectOption({ value: matchedOptionValue }, { timeout: 4000 });
        await page.waitForTimeout(80 + attempt * 40);

        currentState = await readSelectState();
        if (selectMatchesExpected(currentState)) {
          return { ok: true };
        }
      }

      throw new Error(
        `typeTool verification failed for select "${selector}". Expected "${expectedTrim}" but got ` +
          `"${currentState.label || currentState.value}".`
      );
    }

    const existingState = await hasExpectedValue();
    if (existingState.matches) {
      return { ok: true };
    }

    const clearTarget = async (candidate: any) => {
      if (!clear) return;
      await candidate.fill("").catch(() => {});
      await candidate.click({ timeout: 2500 }).catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
    };

    const typeWithKeyboard = async (candidate: any) => {
      await candidate.click({ timeout: 3000 }).catch(() => {});
      if (clear) {
        await page.keyboard.press("Control+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      }
      await page.keyboard.type(expected, { delay: 10 });
    };

    await clearTarget(target);

    let lastVal = "";

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) {
        const filled = await target.fill(expected, { timeout: 4000 }).then(() => true).catch(() => false);
        if (!filled) {
          await typeWithKeyboard(target);
        }
      } else if (attempt === 1) {
        await clearTarget(target);
        await typeWithKeyboard(target);
      } else {
        await clearTarget(loc);
        await typeWithKeyboard(loc);
      }

      await page.waitForTimeout(60 + attempt * 30);
      const state = await hasExpectedValue();
      lastVal = state.lastValue;
      if (state.matches) {
        return { ok: true };
      }

      await clearTarget(target);
    }

    throw new Error(
      `typeTool verification failed for selector "${selector}". Expected "${maskIfNeeded(expected)}" but got "${maskIfNeeded(
        lastVal
      )}".`
    );
  },
});
