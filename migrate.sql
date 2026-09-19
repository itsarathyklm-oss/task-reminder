-- Run each statement ONE AT A TIME in MySQL Workbench.
-- If you get "Duplicate column name" error, that's fine — just move to the next line.

-- software_projects: document columns
ALTER TABLE software_projects ADD COLUMN doc_type VARCHAR(50) DEFAULT NULL;
ALTER TABLE software_projects ADD COLUMN file_name VARCHAR(255) DEFAULT NULL;
ALTER TABLE software_projects ADD COLUMN file_path VARCHAR(255) DEFAULT NULL;
ALTER TABLE software_projects ADD COLUMN status VARCHAR(20) DEFAULT 'active';

-- payment_history: payment details columns
ALTER TABLE payment_history ADD COLUMN payment_method VARCHAR(50) DEFAULT NULL;
ALTER TABLE payment_history ADD COLUMN notes TEXT DEFAULT NULL;

-- reminders table
CREATE TABLE IF NOT EXISTS reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT DEFAULT NULL,
    reminder_date DATETIME NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium',
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- payment_history: file columns for tracking uploaded documents per payment
ALTER TABLE payment_history ADD COLUMN file_name VARCHAR(255) DEFAULT NULL;
ALTER TABLE payment_history ADD COLUMN file_path VARCHAR(255) DEFAULT NULL;
ALTER TABLE payment_history ADD COLUMN doc_type VARCHAR(50) DEFAULT NULL;

-- daily_tasks: change due_date from DATE to DATETIME so time is preserved
ALTER TABLE daily_tasks MODIFY COLUMN due_date DATETIME NOT NULL;
