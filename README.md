# aSocial Media Server

A backend server for the aSocial Media application - a social media platform designed for introverts to connect and share their thoughts in a more comfortable environment.

## Overview

This server provides the API endpoints for the aSocial Media client application, handling user management, posts, comments, and likes functionality.

## Features

- User authentication and profile management
- Post creation, editing, and deletion
- Comment functionality with edit and delete options
- Like/unlike posts
- Popular posts ranking based on like count
- Pagination for post retrieval

## Tech Stack

- Node.js
- Express.js
- MongoDB (with MongoDB Atlas)
- Vercel for deployment

## API Endpoints

### User Management

- `POST /users` - Create a new user
- `GET /user/:email` - Get user by email
- `GET /user/username/:username` - Get user by username
- `GET /users` - Get all users
- `PATCH /user/:email` - Update user information

### Posts

- `GET /posts/:email` - Get posts by user email
- `GET /posts` - Get all posts with pagination
- `GET /posts/popular` - Get popular posts based on like count
- `POST /posts` - Create a new post
- `PATCH /post/:id` - Edit a post
- `DELETE /post/:id` - Delete a post
- `PATCH /posts/:email` - Update username in posts

### Comments

- `GET /comments/:id` - Get comments for a post
- `POST /comments` - Add a comment
- `PATCH /comment/:id` - Edit a comment
- `DELETE /comment/:id` - Delete a comment
- `PATCH /comments/:email` - Update username in comments

### Likes

- `POST /likes` - Add a like
- `DELETE /like/:id` - Remove a like
- `GET /likes/count/:postId` - Get like count for a post
- `GET /likes/:postId/:email` - Check if user has liked a post

## Installation and Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   DB_USER=your_mongodb_username
   DB_PASS=your_mongodb_password
   PORT=5000
   ```
4. Run the development server:
   ```bash
   npm run dev
   ```

## Deployment

The server is configured for deployment on Vercel with the included `vercel.json` configuration file.

## Client Repository

The frontend client for this application can be found at https://github.com/junaaid96/asocial-media-client

## Live API

The API is live at: https://asocial-media-server.vercel.app/
