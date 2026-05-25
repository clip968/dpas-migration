export const cardContentTemplate = {
  sections: [
    'oneLineConclusion',
    'keyQuestion',
    'prerequisites',
    'plainExplanation',
    'inputTransformOutput',
    'visual',
    'workedExample',
    'whyItMatters',
    'repoContext',
    'commonConfusions',
    'codeEvidence',
    'checkQuestions',
    'nextSteps',
    'sources',
  ],
  minimums: { commonConfusions: 2, codeEvidence: 2, checkQuestions: 2, nextSteps: 2, sources: 2 },
} as const;
