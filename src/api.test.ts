import { describe, expect, it } from 'bun:test';
import { coerceValue, pathToCommand, resolveCommand, resolveWithImpliedAction, validationHint } from './api.js';

describe('pathToCommand', () => {
    it('GET /stores → stores list', () => {
        expect(pathToCommand('GET', '/stores')).toBe('stores list');
    });

    it('GET /stores/{storeId} → stores get', () => {
        expect(pathToCommand('GET', '/stores/{storeId}')).toBe('stores get');
    });

    it('POST /stores → stores create', () => {
        expect(pathToCommand('POST', '/stores')).toBe('stores create');
    });

    it('PUT /stores/{storeId} → stores update', () => {
        expect(pathToCommand('PUT', '/stores/{storeId}')).toBe('stores update');
    });

    it('DELETE /stores/{storeId} → stores delete', () => {
        expect(pathToCommand('DELETE', '/stores/{storeId}')).toBe('stores delete');
    });

    it('POST /auth/login → auth login (verb-like last segment)', () => {
        expect(pathToCommand('POST', '/auth/login')).toBe('auth login');
    });

    it('POST /customers/search → customers search', () => {
        expect(pathToCommand('POST', '/customers/search')).toBe('customers search');
    });

    it('GET /reports/v2/monthly → reports v2 monthly list', () => {
        expect(pathToCommand('GET', '/reports/v2/monthly')).toBe('reports v2 monthly list');
    });

    it('POST /wallet/transaction/create → wallet transaction create', () => {
        expect(pathToCommand('POST', '/wallet/transaction/create')).toBe('wallet transaction create');
    });
});

describe('coerceValue', () => {
    it('keeps JSON types and falls back to the raw string', () => {
        expect(coerceValue('100')).toBe(100);
        expect(coerceValue('true')).toBe(true);
        expect(coerceValue('[{"id":"a"}]')).toEqual([{ id: 'a' }]);
        expect(coerceValue('831169395ee9f93e34')).toBe('831169395ee9f93e34');
        expect(coerceValue('hello world')).toBe('hello world');
    });
});

describe('resolveCommand with colliding commands', () => {
    const spec = {
        paths: {
            '/terminals/read/{merchantId}': { get: {} },
            '/terminals/read/{merchantId}/{storeId}/{terminalId}': { get: {} },
        },
    };

    it('picks the 1-param route when only merchantId is given', () => {
        const r = resolveCommand(spec, ['terminals', 'read', 'm1'], 3, new Set());
        expect(r?.path).toBe('/terminals/read/{merchantId}');
    });

    it('picks the 3-param route when all three params are given', () => {
        const r = resolveCommand(spec, ['terminals', 'read', 'm1', 's1', 't1'], 5, new Set());
        expect(r?.path).toBe('/terminals/read/{merchantId}/{storeId}/{terminalId}');
        const n = resolveCommand(spec, ['terminals', 'read'], 2, new Set(['merchantId', 'storeId', 'terminalId']));
        expect(n?.path).toBe('/terminals/read/{merchantId}/{storeId}/{terminalId}');
    });
});

describe('resolveWithImpliedAction', () => {
    const spec = {
        paths: {
            '/analytics/order-stats': { post: {} },
            '/stores/{storeId}': { get: {}, put: {} },
            '/stores': { get: {}, post: {} },
        },
    };

    it('accepts a short form when exactly one action matches', () => {
        const r = resolveWithImpliedAction(spec, ['analytics', 'order-stats']);
        expect(r?.path).toBe('/analytics/order-stats');
        expect(r?.method).toBe('POST');
    });

    it('never guesses when several actions match', () => {
        expect(resolveWithImpliedAction(spec, ['stores'])).toBeNull();
    });

    it('prefers an exact command', () => {
        expect(resolveWithImpliedAction(spec, ['stores', 'create'])?.method).toBe('POST');
    });
});

describe('validationHint', () => {
    const operation = { requestBody: { content: { 'application/json': { schema: { required: ['referenceType', 'referenceId'] } } } } };

    it('names required fields on validation errors only', () => {
        expect(validationHint(['VALIDATION_ERROR'], operation)).toBe('. Required fields: referenceType, referenceId');
        expect(validationHint(['NOT_FOUND'], operation)).toBe('');
        expect(validationHint(['VALIDATION_ERROR'], {})).toBe('');
    });
});
