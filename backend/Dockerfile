# Use the official Node.js image from the Docker Hub, specifying version 18
FROM node:20.5.1-alpine3.18

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json /app

# Install Node.js dependencies
RUN npm ci
RUN npm install

# Copy the rest of the application code to the working directory
COPY . /app

# Expose the application port
EXPOSE 3001

# Define the command to run the application
CMD [ "node", "./src/server.js" ]
