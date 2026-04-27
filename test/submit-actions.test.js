import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubmitActions } from '../src/automation/submit-actions.js';

test('resolveSubmitActions should build action list from submitSequence', () => {
  const actions = resolveSubmitActions({
    submitSequence: [
      { selector: 'button.step-1' },
      { selector: 'button.step-2', confirmSelector: 'button.confirm-2' },
      { selector: 'button.step-3', waitMs: 500 },
    ],
  }, 'personal');

  assert.equal(actions.length, 3);
  assert.equal(actions[0].type, 'click');
  assert.equal(actions[0].selector, 'button.step-1');
  assert.equal(actions[1].confirmSelector, 'button.confirm-2');
  assert.equal(actions[2].waitMs, 500);
});

test('resolveSubmitActions should fallback to single submitSelector', () => {
  const actions = resolveSubmitActions({
    submitSelector: 'button.submit',
    confirmSelector: 'button.confirm',
  }, 'leader');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'click');
  assert.equal(actions[0].selector, 'button.submit');
  assert.equal(actions[0].confirmSelector, 'button.confirm');
});

test('resolveSubmitActions should support drag actions for slider captcha', () => {
  const actions = resolveSubmitActions({
    submitSequence: [
      { selector: '.slider-handle', type: 'drag', distance: 352, steps: 45 },
    ],
  }, 'personal');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'drag');
  assert.equal(actions[0].selector, '.slider-handle');
  assert.equal(actions[0].distance, 352);
  assert.equal(actions[0].steps, 45);
});

test('resolveSubmitActions should support exact text card clicks', () => {
  const actions = resolveSubmitActions({
    submitSequence: [
      { selector: 'text=/^在校$/', type: 'clickExactTextCard', text: '在校' },
    ],
  }, 'personal');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'clickExactTextCard');
  assert.equal(actions[0].text, '在校');
});

test('resolveSubmitActions should require text for exact text card clicks', () => {
  assert.throws(() => {
    resolveSubmitActions({
      submitSequence: [
        { selector: 'text=/^在校$/', type: 'clickExactTextCard' },
      ],
    }, 'personal');
  }, /site config invalid submitSequence item: personal\.submitSequence\[0\]\.text/);
});

test('resolveSubmitActions should support exact text offset clicks', () => {
  const actions = resolveSubmitActions({
    submitSequence: [
      {
        selector: 'text=/^不在校$/',
        type: 'clickExactTextOffset',
        text: '不在校',
        offsetX: -180,
        offsetY: 0,
      },
    ],
  }, 'personal');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'clickExactTextOffset');
  assert.equal(actions[0].text, '不在校');
  assert.equal(actions[0].offsetX, -180);
  assert.equal(actions[0].offsetY, 0);
});

test('resolveSubmitActions should support dragging a track by text', () => {
  const actions = resolveSubmitActions({
    submitSequence: [
      {
        selector: 'text=向右拖动滑块',
        type: 'dragTrackByText',
        text: '向右拖动滑块',
        distance: 430,
        steps: 45,
      },
    ],
  }, 'personal');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'dragTrackByText');
  assert.equal(actions[0].text, '向右拖动滑块');
  assert.equal(actions[0].distance, 430);
});

test('resolveSubmitActions should require drag distance', () => {
  assert.throws(() => {
    resolveSubmitActions({
      submitSequence: [
        { selector: '.slider-handle', type: 'drag' },
      ],
    }, 'personal');
  }, /site config invalid submitSequence item: personal\.submitSequence\[0\]\.distance/);
});

test('resolveSubmitActions should throw when submitSequence is invalid', () => {
  assert.throws(() => {
    resolveSubmitActions({
      submitSequence: [
        { selector: 'button.ok' },
        { notSelector: '.bad' },
      ],
    }, 'personal');
  }, /site config invalid submitSequence item: personal\.submitSequence\[1\]\.selector/);
});
