import { Plugin, Transaction, EditorState } from 'prosemirror-state';
import {
  ReplaceStep,
  AddMarkStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  Transform,
  Mapping,
} from 'prosemirror-transform';
import {
  SuggestionModePluginState,
  suggestionPluginKey,
  suggestionTransactionKey,
} from './key';
import {
  SuggestionHoverMenuRenderer,
  hoverMenuFactory,
  SuggestionHoverMenuOptions,
} from './hoverMenu';
import { createDecorations } from './decorations';
import { initSuggestionHoverListeners } from './hoverHandlers';
import { findNonStartingPos } from './helpers/nodePosition';

type AnyStep = ReplaceStep | AddMarkStep | RemoveMarkStep | ReplaceAroundStep;

function isReplaceStep(step: AnyStep): step is ReplaceStep {
  return 'slice' in step && !('gapFrom' in step);
}

function isReplaceAroundStep(step: AnyStep): step is ReplaceAroundStep {
  return 'slice' in step && 'gapFrom' in step && 'gapTo' in step;
}

export interface SuggestionModePluginOptions {
  inSuggestionMode?: boolean;
  username?: string;
  data?: Record<string, any>;
  hoverMenuRenderer?: SuggestionHoverMenuRenderer;
  hoverMenuOptions?: SuggestionHoverMenuOptions;
}

export const suggestionModePlugin = (
  options: SuggestionModePluginOptions = {}
) => {
  const renderHoverMenu =
    options.hoverMenuRenderer ||
    hoverMenuFactory(options?.hoverMenuOptions || {});

  let currentListeners: WeakMap<HTMLElement, any> | null = null;

  return new Plugin({
    key: suggestionPluginKey,

    appendTransaction(
      transactions: readonly Transaction[],
      oldState: EditorState,
      newState: EditorState
    ) {
      const pluginState = this.getState(oldState);
      let tr = newState.tr;
      let changed = false;

      let intermediateTr = new Transform(oldState.doc);
      let lastStep: AnyStep | null = null;

      transactions.forEach((transaction, trIndex) => {
        if (transaction.getMeta('history$')) return;

        const transactionMeta = transaction.getMeta(suggestionTransactionKey);
        const mergedData = {
          ...pluginState.data,
          ...transactionMeta?.data,
        };
        const meta = {
          ...pluginState,
          ...transactionMeta,
          data: mergedData,
        };
        if (!meta.inSuggestionMode) return;
        if (meta && meta.skipSuggestionOperation) return;

        const username = meta.username;

        transaction.steps.forEach((step: AnyStep, stepIndex: number) => {
          if (lastStep) intermediateTr.step(lastStep);
          lastStep = step;

          const removedSlice = intermediateTr.doc.slice(step.from, step.to, false);
          let addedSliceSize = isReplaceStep(step)
            ? step.slice.size
            : removedSlice.size;
          let extraInsertChars = 0;

          if (isReplaceAroundStep(step)) {
            addedSliceSize = step.gapTo - step.gapFrom + step.slice.size;
          }

          tr.setMeta(suggestionTransactionKey, {
            skipSuggestionOperation: true,
          });

          const $pos = intermediateTr.doc.resolve(step.from);
          const marksAtPos = $pos.marks();
          const existingSuggestionMark = marksAtPos.find(
            (m) =>
              m.type.name === 'suggestion_insert' ||
              m.type.name === 'suggestion_delete'
          );

          let from = step.from;
          if (existingSuggestionMark) {
            if (addedSliceSize > 1) {
              tr.addMark(from, from + addedSliceSize, existingSuggestionMark);
              changed = true;
            }
            return;
          }

          if (removedSlice.size > 0) {
            //  Skip pure newline/whitespace deletions
            const removedText = removedSlice.content.textBetween(
              0,
              removedSlice.size,
              '\n',
              '\n'
            );
            if (!removedText.replace(/\s/g, '').length) {
              return; // ignore empty / newline-only deletions
            }


            const isBackspace =
              (isReplaceStep(step) || isReplaceAroundStep(step)) &&
              step.slice.size === 0 &&
              newState.selection.from === step.from;

            const mapToNewDocPos: Mapping = transactions
              .slice(trIndex)
              .reduce((acc, tr, i) => {
                const startStep = i === 0 ? stepIndex : 0;
                tr.steps.slice(startStep).forEach((s) => {
                  acc.appendMap(s.getMap());
                });
                return acc;
              }, new Mapping());

            from = mapToNewDocPos.map(step.from);
            from = tr.mapping.map(from);

            const $from = tr.doc.resolve(from);
            from = findNonStartingPos($from);

            // Removed pilcrow logic entirely, just restore + mark
            tr.replace(from, from, removedSlice);
            tr.addMark(
              from,
              from + removedSlice.size,
              newState.schema.marks.suggestion_delete.create({
                username,
                data: meta.data,
              })
            );


            if (isBackspace) {
              tr.setSelection(tr.selection.constructor.create(tr.doc, from));
            }

            changed = true;
          }

          if (addedSliceSize > 0) {
            const addedFrom = from + removedSlice.size;
            const addedTo = addedFrom + addedSliceSize + extraInsertChars;

            tr.addMark(
              addedFrom,
              addedTo,
              newState.schema.marks.suggestion_insert.create({
                username,
                data: meta.data,
              })
            );
            changed = true;
          }
        });
      });

      return changed ? tr : null;
    },

    state: {
      init(): SuggestionModePluginState {
        return {
          inSuggestionMode: options.inSuggestionMode || false,
          username: options.username || 'Anonymous',
          data: options.data || {},
        };
      },

      apply(tr: Transaction, value: SuggestionModePluginState): SuggestionModePluginState {
        const meta = tr.getMeta(suggestionPluginKey);
        const data = {
          ...value.data,
          ...meta?.data,
        };
        if (meta) {
          return {
            ...value,
            ...meta,
            data,
          };
        }
        return value;
      },
    },

    props: {
      decorations(state: EditorState) {
        if (options.hoverMenuOptions?.disabled) return null;
        return createDecorations(state, renderHoverMenu);
      },
    },

    view(view) {
      if (options.hoverMenuOptions?.disabled) return null;
      setTimeout(() => {
        currentListeners = initSuggestionHoverListeners(view);
      }, 0);

      return {
        update(view, prevState) {
          if (view.state.doc !== prevState.doc) {
            setTimeout(() => {
              currentListeners = initSuggestionHoverListeners(view);
            }, 0);
          }
        },
        destroy() {
          currentListeners = null;
        },
      };
    },
  });
};
