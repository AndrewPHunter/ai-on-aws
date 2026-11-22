// The gate's fixed set for the embedding server and the reranker: synthetic queries, each with one passage
// that answers it and several that do not. Everyday topics written for the gate; none is taken from a source.

export type RetrievalCase = { query: string; answer: string; others: string[] }

export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    query: 'How often are the office plants watered?',
    answer: 'The office plants are watered every Tuesday and Friday morning by the facilities team.',
    others: [
      'The office kitchen is cleaned every evening after six.',
      'Visitors sign in at the front desk on the ground floor.',
      'The printer on the third floor takes A4 and letter paper.',
    ],
  },
  {
    query: 'What time does the community pool open at the weekend?',
    answer: 'On Saturdays and Sundays the community pool opens at eight in the morning.',
    others: [
      'The library closes early on public holidays.',
      'Parking at the sports centre is free for members.',
      'Swimming lessons for children are booked through the front office.',
    ],
  },
  {
    query: 'How do I reset my password for the staff portal?',
    answer: "To reset your staff portal password, choose 'Forgot password' on the sign-in page and follow the link sent to your email.",
    others: [
      'The staff portal shows how many holiday days each employee has left.',
      'Payslips are published on the last working day of each month.',
      'The canteen accepts card payments only.',
    ],
  },
  {
    query: 'Which train goes from the harbour to the airport?',
    answer: 'The blue line runs from the harbour station to the airport every fifteen minutes.',
    others: [
      'The harbour market sells fresh fish on Saturday mornings.',
      'Taxis wait outside the main entrance of the airport.',
      'Bicycles can be hired near the old lighthouse.',
    ],
  },
  {
    query: 'How long should bread dough be left to rise?',
    answer: 'Leave the bread dough to rise for about one hour, until it has doubled in size.',
    others: [
      'Heat the oven to two hundred degrees before you start baking.',
      'Keep flour in a cool, dry cupboard.',
      'A serrated knife cuts fresh bread more cleanly.',
    ],
  },
  {
    query: 'What should I do when the fire alarm sounds?',
    answer: 'When the fire alarm sounds, leave by the nearest exit and gather at the assembly point in the car park.',
    others: [
      'The fire extinguishers are inspected once a year.',
      'Smoking is not allowed anywhere on the site.',
      'The lifts are serviced on the first Monday of each month.',
    ],
  },
  {
    query: 'How much luggage can I take on the ferry?',
    answer: 'Each ferry passenger may bring two suitcases and one small bag free of charge.',
    others: [
      'The ferry cafe serves hot meals until nine in the evening.',
      'Cars must be at the ferry terminal forty minutes before departure.',
      'Pets travel in the kennels on the lower deck.',
    ],
  },
  {
    query: 'When is the recycling collected?',
    answer: 'Recycling bins are emptied every other Thursday, so put them out on Wednesday night.',
    others: [
      'Garden waste can be taken to the depot on Saturdays.',
      'Large items such as sofas need a booked collection.',
      "Street lights are repaired by the council's lighting team.",
    ],
  },
  {
    query: 'How do I fix a flat bicycle tyre?',
    answer: 'To fix a flat tyre, take the wheel off, lever the tyre away from the rim, fit a new inner tube and pump it up.',
    others: [
      'Bicycle lights must be switched on after sunset.',
      'The cycle path along the river is closed for repairs in March.',
      'A good helmet sits level on your head.',
    ],
  },
  {
    query: 'What is the deadline for expense claims?',
    answer: 'Expense claims must be submitted within thirty days of the date of purchase.',
    others: [
      'The finance team sits on the fourth floor.',
      'Company credit cards are issued to managers only.',
      'Travel is booked through the approved agency.',
    ],
  },
]

// The passages of a case in the order they are sent, with the answer at a position that moves from case to
// case, so that no check can pass by favouring one position.
export function passagesOf(entry: RetrievalCase, caseIndex: number): { passages: string[]; answerIndex: number } {
  const answerIndex = caseIndex % (entry.others.length + 1)
  const passages = [...entry.others]
  passages.splice(answerIndex, 0, entry.answer)
  return { passages, answerIndex }
}
