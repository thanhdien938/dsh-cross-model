import React from 'react';
import { Project } from '../../electron/main/types';
import './ProjectList.css';

interface ProjectListProps {
  projects: Project[];
  selectedProject: string | null;
  armedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onArmProject: (projectId: string) => void;
  onAddFolder: () => void;
}

function ProjectList({ projects, selectedProject, armedProjectId, onSelectProject, onArmProject, onAddFolder }: ProjectListProps) {
  return (
    <div className="project-list">
      <div className="project-list-header">
        <h3 className="section-title">Projects</h3>
      </div>

      <div className="project-list-content">
        <button
          type="button"
          aria-pressed={selectedProject === null}
          className={`project-item project-select-control ${selectedProject === null ? 'project-item-active' : ''}`}
          onClick={() => onSelectProject(null)}
        >
          <span className="project-name">All Projects</span>
          <span className="project-count">{projects.length}</span>
        </button>

        {projects.length === 0 && (
          <div className="project-list-empty">
            No projects found. Start runtime to load configured projects, or Add Folder below.
          </div>
        )}

        {projects.map((project) => {
          const isArmed = project.id === armedProjectId;
          const pathMissing = project.state === 'PATH_MISSING';
          return (
            <div
              key={project.id}
              className={`project-item ${selectedProject === project.id ? 'project-item-active' : ''}`}
            >
              <button
                type="button"
                className="project-select-control"
                aria-pressed={selectedProject === project.id}
                onClick={() => onSelectProject(project.id)}
              >
                <span className="project-item-row">
                  <span className="project-name">{project.name}</span>
                  {isArmed && <span className="project-armed-badge">ARMED</span>}
                  {pathMissing && <span className="project-missing-badge">PATH MISSING</span>}
                </span>
                <span className="project-path">{project.path}</span>
                {project.branch && (
                  <span className="project-branch">
                    <span className="project-branch-icon">⎇</span>
                    {project.branch}
                  </span>
                )}
                {pathMissing && (
                  <span className="project-missing-note">
                    Configured folder not found at this path. Restore it and restart to use this project.
                  </span>
                )}
                {project.state && !pathMissing && (
                  <span className="project-state">{project.state}</span>
                )}
              </button>
              {!isArmed && (
                <button
                  type="button"
                  className="btn btn-secondary project-arm-btn"
                  disabled={pathMissing}
                  title={pathMissing ? 'Restore the configured folder and restart before arming' : undefined}
                  onClick={() => onArmProject(project.id)}
                >
                  ARM
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="project-list-footer">
        <button type="button" className="btn btn-secondary project-add-folder-btn" onClick={onAddFolder}>
          + Add Folder
        </button>
      </div>
    </div>
  );
}

export default ProjectList;
