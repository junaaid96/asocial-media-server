// Gentle daily writing prompts. One is chosen per UTC day, so everyone
// answers the same question together.
const PROMPTS = [
  "What small thing made today a little softer?",
  "Describe a place where you feel completely at ease.",
  "What's a book, song, or film that understood you?",
  "What does your ideal quiet evening look like?",
  "Write about a conversation you keep replaying — kindly.",
  "What is something you're slowly getting better at?",
  "Which season matches your mood right now, and why?",
  "What would you tell yourself from a year ago?",
  "Describe a sound that instantly calms you.",
  "What's a tiny ritual that keeps you grounded?",
  "Who is someone you're quietly grateful for?",
  "What's a thought you've been too shy to share?",
  "Write about the last time you felt truly understood.",
  "What does recharging look like for you this week?",
  "What's a small adventure you'd like to take alone?",
  "Describe your perfect rainy day.",
  "What are you curious about lately?",
  "What's something you've let go of recently?",
  "Write a short letter to your future self.",
  "What does 'enough' feel like to you?",
  "What is a comfort you return to again and again?",
  "Share a memory that smells like home.",
  "What boundary are you proud of setting?",
  "What would you create if no one would ever see it?",
  "What's the most peaceful moment of your day?",
  "Describe a stranger's kindness you still remember.",
  "What does your inner voice sound like today?",
  "What's a question you wish people asked you more?",
  "Write about a window you love looking out of.",
  "What's one thing you're looking forward to, however small?",
  "What do you notice when you slow down?",
  "Describe your favourite corner of your home.",
  "What's a lesson solitude taught you?",
  "Which word describes this month so far?",
  "What would a gentle version of tomorrow look like?",
  "What's something beautiful you saw this week?",
  "Write about a friendship that grew slowly.",
  "When do you feel most like yourself?",
  "What does courage look like in quiet people?",
  "What's a hobby that lets your mind wander?",
];

export interface DailyPrompt {
  date: string;
  text: string;
}

export function promptFor(date = new Date()): DailyPrompt {
  const day = Math.floor(date.getTime() / 86_400_000);
  return {
    date: date.toISOString().slice(0, 10),
    text: PROMPTS[day % PROMPTS.length]!,
  };
}
