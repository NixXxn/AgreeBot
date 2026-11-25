import { mergeTraderLists, parseAddressList } from '../mergeTraders';

describe('mergeTraderLists', () => {
    const manual = '0x1111111111111111111111111111111111111111';
    const pipelineA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const pipelineB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const pipelineC = '0xcccccccccccccccccccccccccccccccccccccccc';

    it('parses and dedupes address lists', () => {
        expect(
            parseAddressList(`${manual}, ${manual.toUpperCase()}, not-an-address, ${pipelineA}`)
        ).toEqual([manual, pipelineA]);
    });

    it('keeps manual traders when pipeline adds one', () => {
        const result = mergeTraderLists({
            current: [manual, pipelineA],
            previousPipeline: [],
            nextPipeline: [pipelineA],
        });
        expect(result.keptManual).toEqual([manual, pipelineA]);
        expect(result.merged).toEqual([manual, pipelineA]);
        expect(result.added).toEqual([]);
        expect(result.removedPipeline).toEqual([]);
    });

    it('does not wipe the list when pipeline only found one wallet', () => {
        const result = mergeTraderLists({
            current: [manual, pipelineA, pipelineB],
            previousPipeline: [],
            nextPipeline: [pipelineC],
        });
        expect(result.merged).toEqual([manual, pipelineA, pipelineB, pipelineC]);
        expect(result.added).toEqual([pipelineC]);
        expect(result.removedPipeline).toEqual([]);
    });

    it('only rotates out previously pipeline-applied wallets', () => {
        const result = mergeTraderLists({
            current: [manual, pipelineA, pipelineB],
            previousPipeline: [pipelineA, pipelineB],
            nextPipeline: [pipelineB, pipelineC],
        });
        expect(result.keptManual).toEqual([manual]);
        expect(result.merged).toEqual([manual, pipelineB, pipelineC]);
        expect(result.removedPipeline).toEqual([pipelineA]);
        expect(result.added).toEqual([pipelineC]);
    });
});
